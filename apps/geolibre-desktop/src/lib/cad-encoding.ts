/**
 * Repair CAD (DXF/DWG) string fields after DuckDB-WASM `ST_Read`.
 *
 * AutoCAD stores TEXT in `$DWGCODEPAGE` (DXF) or the DWG header codepage.
 * Desktop GDAL recodes to UTF-8; WASM GDAL has no iconv, so each file byte
 * becomes a Latin-1 / Windows-1252 character. Recode those strings — recover
 * the original bytes, then decode with the drawing codepage — at the GeoJSON
 * boundary so DXF and DWG share one path. Rewriting the file as UTF-8 does
 * not help: WASM GDAL still copies bytes as Latin-1.
 *
 * Kept free of the DuckDB-WASM import so `node --test` can cover it without
 * pulling the engine into the coverage denominator.
 */

import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";

const HEADER_PROBE_BYTES = 64 * 1024;
const BINARY_DXF_MAGIC = "AutoCAD Binary DXF";
const CAD_EXTENSIONS = new Set(["dxf", "dwg"]);
/** R2007 (AC1021) and later DWG store Unicode internally. */
const DWG_UNICODE_VERSION = 1021;

/** AutoCAD `$DWGCODEPAGE` / DWG token → WHATWG `TextDecoder` label. */
const CODEPAGE_LABELS: Record<string, string> = {
  "UTF-8": "utf-8",
  UTF8: "utf-8",
  ANSI_936: "gb18030",
  GBK: "gb18030",
  GB2312: "gb18030",
  GB18030: "gb18030",
  ANSI_950: "big5",
  BIG5: "big5",
  ANSI_932: "shift_jis",
  SHIFT_JIS: "shift_jis",
  ANSI_949: "euc-kr",
  ANSI_1252: "windows-1252",
  "ISO8859-1": "latin1",
  "ISO-8859-1": "latin1",
  ASCII: "latin1",
  "US-ASCII": "latin1",
  ANSI_1250: "windows-1250",
  ANSI_1251: "windows-1251",
  ANSI_1253: "windows-1253",
  ANSI_1254: "windows-1254",
  ANSI_1255: "windows-1255",
  ANSI_1256: "windows-1256",
  ANSI_1257: "windows-1257",
  ANSI_1258: "windows-1258",
};

const DWGCODEPAGE_VALUE = /\$DWGCODEPAGE\r?\n[ \t]*3\r?\n([^\r\n]+)/i;
const CODEPAGE_TOKEN = /\b(UTF-?8|GBK|GB2312|GB18030|BIG5|SHIFT_JIS|ANSI_\d{3,4})\b/i;

/**
 * Windows-1252 codepoints for bytes 0x80–0x9F (WHATWG `latin1` is 1252).
 * A UTF-8/GBK trail byte in that range (e.g. UTF-8 `×` = C3 97 → `—`) must
 * map back to the original file byte before the drawing codepage is applied.
 */
const WINDOWS_1252_REVERSE = new Map<number, number>([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
]);

/**
 * Decode a Latin-1 prefix so ASCII CAD headers can be scanned.
 *
 * @param bytes The CAD file bytes.
 * @returns The first {@link HEADER_PROBE_BYTES} decoded as Latin-1.
 */
function headerLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(
    bytes.subarray(0, Math.min(bytes.length, HEADER_PROBE_BYTES)),
  );
}

/**
 * True when the buffer is a binary DXF (not the ASCII/ANSI text form).
 *
 * @param bytes The file bytes.
 * @returns True when the AutoCAD binary-DXF magic is present.
 */
function isBinaryDxf(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_DXF_MAGIC.length) return false;
  for (let i = 0; i < BINARY_DXF_MAGIC.length; i += 1) {
    if (bytes[i] !== BINARY_DXF_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Map an AutoCAD codepage name to a `TextDecoder` label, if supported.
 *
 * @param codepage An uppercased `$DWGCODEPAGE` / DWG token.
 * @returns A WHATWG encoding label, or null when unknown/unsupported.
 */
function decoderLabelForCodepage(codepage: string): string | null {
  const mapped = CODEPAGE_LABELS[codepage];
  if (!mapped) return null;
  try {
    new TextDecoder(mapped);
    return mapped;
  } catch {
    return null;
  }
}

/**
 * Normalize a scanned codepage token to a CODEPAGE_LABELS key.
 *
 * @param raw A token such as `ansi_936` or `utf8`.
 * @returns The uppercased key, with `UTF8` folded to `UTF-8`.
 */
function normalizeCodepageToken(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return upper === "UTF8" ? "UTF-8" : upper;
}

/**
 * Find an AutoCAD codepage name embedded as ASCII in a binary header.
 *
 * @param bytes The CAD file bytes.
 * @returns An uppercased codepage name, or null when none is present.
 */
function findCodepageToken(bytes: Uint8Array): string | null {
  const match = CODEPAGE_TOKEN.exec(headerLatin1(bytes));
  return match?.[1] ? normalizeCodepageToken(match[1]) : null;
}

/**
 * Read `$DWGCODEPAGE` from an ASCII DXF header.
 *
 * @param bytes The DXF file bytes.
 * @returns The codepage name, or null when absent/binary.
 */
function readDxfCodepage(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || isBinaryDxf(bytes)) return null;
  const match = DWGCODEPAGE_VALUE.exec(headerLatin1(bytes));
  const value = match?.[1]?.trim();
  return value ? normalizeCodepageToken(value) : findCodepageToken(bytes);
}

/**
 * Read the drawing codepage from a DWG header.
 *
 * R2007+ (`AC1021` and later) store Unicode; older files are scanned for an
 * `ANSI_*` / `UTF-8` token. Real Unicode strings later no-op in
 * {@link recodeCadString}, so labelling R2007+ as UTF-8 is safe.
 *
 * @param bytes The DWG file bytes.
 * @returns The codepage name, or null when it cannot be determined.
 */
function readDwgCodepage(bytes: Uint8Array): string | null {
  const version = new TextDecoder("latin1").decode(bytes.subarray(0, 6));
  const acad = /^AC(\d{4})/.exec(version);
  if (acad && Number(acad[1]) >= DWG_UNICODE_VERSION) return "UTF-8";
  return findCodepageToken(bytes);
}

/**
 * Read the drawing codepage for a CAD file (DXF or DWG).
 *
 * @param bytes The file bytes (must be read before DuckDB detaches the buffer).
 * @param extension The lowercased file extension (`dxf`, `dwg`, …).
 * @returns An AutoCAD codepage name, or null when this is not a CAD file.
 */
export function readCadCodepage(bytes: Uint8Array, extension: string): string | null {
  if (!CAD_EXTENSIONS.has(extension) || bytes.length === 0) return null;
  return extension === "dwg" ? readDwgCodepage(bytes) : readDxfCodepage(bytes);
}

/**
 * Rebuild the CAD bytes WASM GDAL copied into a JS string (Latin-1 / 1252).
 *
 * @param value A DuckDB string field.
 * @returns The original bytes, or null when `value` is already real Unicode.
 */
function duckDbStringBytes(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 255) {
      bytes[i] = code;
      continue;
    }
    const winByte = WINDOWS_1252_REVERSE.get(code);
    if (winByte === undefined) return null;
    bytes[i] = winByte;
  }
  return bytes;
}

/**
 * Recode one CAD attribute that WASM GDAL exposed as Latin-1 / 1252 mojibake.
 *
 * @param value The raw DuckDB/OGR string (or already-correct Unicode).
 * @param codepage From {@link readCadCodepage}, or null.
 * @returns Unicode text, or `value` when recoding does not apply.
 */
export function recodeCadString(value: string, codepage: string | null): string {
  if (!value || !codepage) return value;
  const label = decoderLabelForCodepage(codepage);
  if (!label) return value;
  const bytes = duckDbStringBytes(value);
  if (!bytes) return value;
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return value;
  }
}

/**
 * Recode string properties on one feature.
 *
 * @param properties The feature properties object, or null.
 * @param codepage From {@link readCadCodepage}.
 * @returns Properties with CAD strings recoded; non-strings left unchanged.
 */
function recodeCadProperties(
  properties: GeoJsonProperties,
  codepage: string,
): GeoJsonProperties {
  if (!properties) return properties;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    next[key] = typeof value === "string" ? recodeCadString(value, codepage) : value;
  }
  return next;
}

/**
 * Recode string properties on every feature in a CAD-derived collection.
 *
 * @param collection The FeatureCollection `ST_Read` materialized.
 * @param codepage From {@link readCadCodepage}, or null.
 * @returns A new collection when recoding ran; `collection` when it did not.
 */
export function recodeCadFeatureCollection(
  collection: FeatureCollection,
  codepage: string | null,
): FeatureCollection {
  if (!codepage || !decoderLabelForCodepage(codepage)) return collection;
  return {
    ...collection,
    features: collection.features.map((feature: Feature) => ({
      ...feature,
      properties: recodeCadProperties(feature.properties, codepage),
    })),
  };
}
