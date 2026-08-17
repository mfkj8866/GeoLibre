/**
 * Repair DXF string fields after DuckDB-WASM `ST_Read`.
 *
 * AutoCAD TEXT in R2004 and earlier is stored in `$DWGCODEPAGE`; R2007
 * (`AC1021`) and later is UTF-8. Desktop GDAL recodes to UTF-8; WASM GDAL has
 * no iconv, so each file byte becomes a Latin-1 character. Recode those
 * strings — recover the original bytes, then decode with the drawing
 * codepage — at the GeoJSON boundary. Rewriting the file as UTF-8 does not
 * help: WASM GDAL still copies bytes as Latin-1. Binary DXF is left unchanged.
 *
 * Kept free of the DuckDB-WASM import so `node --test` can cover it without
 * pulling the engine into the coverage denominator.
 */

import type { Feature, FeatureCollection, GeoJsonProperties } from "geojson";

const HEADER_PROBE_BYTES = 64 * 1024;
const BINARY_DXF_MAGIC = "AutoCAD Binary DXF";
/** `$ACADVER` numeric suffix at which DXF switched from codepage to UTF-8. */
const UTF8_DXF_VERSION = 1021;

/** AutoCAD `$DWGCODEPAGE` → WHATWG `TextDecoder` label. */
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

/**
 * Decode a Latin-1 prefix so ASCII DXF headers can be scanned.
 *
 * @param bytes The DXF file bytes.
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
 * Read one HEADER variable from an ASCII DXF prefix.
 *
 * @param header Latin-1 text of the file prefix.
 * @param name The variable without `$`, such as `ACADVER`.
 * @param groupCode The DXF group code of the value line (`1` or `3`).
 * @returns The trimmed value, or null when the variable is absent.
 */
function readDxfTaggedValue(header: string, name: string, groupCode: number): string | null {
  const pattern = new RegExp(
    `\\$${name}[ \\t]*\\r?\\n[ \\t]*0*${groupCode}[ \\t]*\\r?\\n([^\\r\\n]+)`,
    "i",
  );
  const value = pattern.exec(header)?.[1]?.trim();
  return value || null;
}

/**
 * True when `$ACADVER` is R2007 or later (UTF-8 DXF).
 *
 * @param acadver A value such as `AC1021`.
 * @returns True when the numeric suffix is >= {@link UTF8_DXF_VERSION}.
 */
function isUtf8DxfVersion(acadver: string): boolean {
  const match = /^AC(\d+)$/i.exec(acadver.trim());
  return match !== null && Number(match[1]) >= UTF8_DXF_VERSION;
}

/**
 * Map an AutoCAD codepage name to a `TextDecoder` label, if supported.
 *
 * @param codepage An uppercased `$DWGCODEPAGE` value.
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
 * Normalize a `$DWGCODEPAGE` value to a CODEPAGE_LABELS key.
 *
 * @param raw A token such as `ansi_936` or `utf8`.
 * @returns The uppercased key, with `UTF8` folded to `UTF-8`.
 */
function normalizeCodepageToken(raw: string): string {
  const upper = raw.trim().toUpperCase();
  return upper === "UTF8" ? "UTF-8" : upper;
}

/**
 * Read the drawing codepage from an ASCII DXF header.
 *
 * R2007+ (`$ACADVER` >= AC1021) is UTF-8 even when `$DWGCODEPAGE` still names
 * a legacy ANSI_* page. Earlier versions use `$DWGCODEPAGE`. Binary DXF and
 * files with neither variable are left unlabelled.
 *
 * @param bytes The file bytes (must be read before DuckDB detaches the buffer).
 * @returns An AutoCAD codepage name, or null when recoding should not run.
 */
export function readDxfCodepage(bytes: Uint8Array): string | null {
  if (bytes.length === 0 || isBinaryDxf(bytes)) return null;
  const header = headerLatin1(bytes);
  const acadver = readDxfTaggedValue(header, "ACADVER", 1);
  if (acadver && isUtf8DxfVersion(acadver)) return "UTF-8";
  const codepage = readDxfTaggedValue(header, "DWGCODEPAGE", 3);
  return codepage ? normalizeCodepageToken(codepage) : null;
}

/**
 * Rebuild the DXF bytes WASM GDAL copied into a JS string as Latin-1.
 *
 * @param value A DuckDB string field.
 * @returns The original bytes, or null when `value` is already real Unicode.
 */
function duckDbStringBytes(value: string): Uint8Array | null {
  const bytes = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code > 255) return null;
    bytes[i] = code;
  }
  return bytes;
}

/**
 * Recode one DXF string with an already-constructed decoder.
 *
 * @param value The raw DuckDB/OGR string (or already-correct Unicode).
 * @param decoder A `TextDecoder` for the drawing codepage.
 * @returns Unicode text, or `value` when recoding does not apply.
 */
function recodeWithDecoder(value: string, decoder: TextDecoder): string {
  if (!value) return value;
  const bytes = duckDbStringBytes(value);
  if (!bytes) return value;
  try {
    return decoder.decode(bytes);
  } catch {
    return value;
  }
}

/**
 * Recode one DXF attribute that WASM GDAL exposed as Latin-1 mojibake.
 *
 * @param value The raw DuckDB/OGR string (or already-correct Unicode).
 * @param codepage From {@link readDxfCodepage}, or null.
 * @returns Unicode text, or `value` when recoding does not apply.
 */
export function recodeCadString(value: string, codepage: string | null): string {
  if (!value || !codepage) return value;
  const label = decoderLabelForCodepage(codepage);
  if (!label) return value;
  return recodeWithDecoder(value, new TextDecoder(label, { fatal: true }));
}

/**
 * Recode string properties on one feature.
 *
 * @param properties The feature properties object, or null.
 * @param decoder A `TextDecoder` for the drawing codepage.
 * @returns Properties with DXF strings recoded; non-strings left unchanged.
 */
function recodeCadProperties(
  properties: GeoJsonProperties,
  decoder: TextDecoder,
): GeoJsonProperties {
  if (!properties) return properties;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    next[key] = typeof value === "string" ? recodeWithDecoder(value, decoder) : value;
  }
  return next;
}

/**
 * Recode string properties on every feature in a DXF-derived collection.
 *
 * @param collection The FeatureCollection `ST_Read` materialized.
 * @param codepage From {@link readDxfCodepage}, or null.
 * @returns A new collection when recoding ran; `collection` when it did not.
 */
export function recodeCadFeatureCollection(
  collection: FeatureCollection,
  codepage: string | null,
): FeatureCollection {
  const label = codepage ? decoderLabelForCodepage(codepage) : null;
  if (!label) return collection;
  const decoder = new TextDecoder(label, { fatal: true });
  return {
    ...collection,
    features: collection.features.map((feature: Feature) => ({
      ...feature,
      properties: recodeCadProperties(feature.properties, decoder),
    })),
  };
}
