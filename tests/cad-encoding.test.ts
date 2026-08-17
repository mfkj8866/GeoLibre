import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Feature, FeatureCollection } from "geojson";
import {
  readCadCodepage,
  recodeCadFeatureCollection,
  recodeCadString,
} from "../apps/geolibre-desktop/src/lib/cad-encoding.ts";

const TEXT_ENCODER = new TextEncoder();

/** GBK bytes for `工程名称` (title-block TEXT in the user's DXF). */
const GONGCHENG_GBK = Uint8Array.from([185, 164, 179, 204, 195, 251, 179, 198]);
/** GBK bytes for `集电线路` (Layer field). */
const JIDIAN_GBK = Uint8Array.from([188, 175, 181, 231, 207, 223, 194, 183]);
/** GBK bytes for `×` (U+00D7); Latin-1 mojibake is `¡Á`. */
const TIMES_GBK = Uint8Array.from([161, 193]);
/** GBK bytes for `兴业大平山风电项目`. */
const XINGYE_GBK = Uint8Array.from([
  208, 203, 210, 181, 180, 243, 198, 189, 201, 189, 183, 231, 181, 231, 207, 238, 196, 191,
]);

/**
 * Concatenate byte arrays into one ArrayBuffer-backed view.
 *
 * @param parts The pieces to join, in order.
 * @returns A single buffer containing every part.
 */
function concatBytes(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Encode ASCII/UTF-8 text as bytes.
 *
 * @param text The text to encode.
 * @returns UTF-8 bytes.
 */
function utf8Bytes(text: string): Uint8Array<ArrayBuffer> {
  return TEXT_ENCODER.encode(text);
}

/**
 * Simulate WASM GDAL: each file byte becomes a Latin-1 character in DuckDB.
 *
 * @param bytes Raw CAD TEXT bytes (GBK, UTF-8, …).
 * @returns The mojibake string the attribute table would show without recode.
 */
function duckDbLatin1(bytes: Uint8Array): string {
  return new TextDecoder("latin1").decode(bytes);
}

/**
 * Build a minimal ASCII DXF header plus a TEXT entity payload.
 *
 * @param codepage The `$DWGCODEPAGE` header value.
 * @param textBytes The group-1 TEXT payload.
 * @param newline The DXF line ending.
 * @returns The DXF bytes.
 */
function dxfWithText(
  codepage: string,
  textBytes: Uint8Array,
  newline = "\n",
): Uint8Array<ArrayBuffer> {
  const nl = newline;
  const head = [
    "  0",
    "SECTION",
    "  2",
    "HEADER",
    "  9",
    "$ACADVER",
    "  1",
    "AC1018",
    "  9",
    "$DWGCODEPAGE",
    "  3",
    codepage,
    "  0",
    "ENDSEC",
    "  0",
    "TEXT",
    "  1",
    "",
  ].join(nl);
  return concatBytes([utf8Bytes(head), textBytes, utf8Bytes(`${nl}  0${nl}EOF${nl}`)]);
}

/**
 * A stub DWG: version sentinel plus an optional ASCII codepage token.
 *
 * @param version The six-byte AC version (`AC1018`, `AC1021`, …).
 * @param token An `ANSI_*` token to embed, or omitted.
 * @returns Fake DWG bytes.
 */
function dwgBytes(version: string, token?: string): Uint8Array<ArrayBuffer> {
  return utf8Bytes(`${version}\0header ${token ?? ""}\0`);
}

/**
 * A point feature whose properties match a CAD TEXT row in the attribute table.
 *
 * @param properties The OGR fields (`Text`, `Layer`, …).
 * @returns A GeoJSON Feature.
 */
function textFeature(properties: Record<string, unknown>): Feature {
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [0, 0] },
    properties,
  };
}

describe("readCadCodepage", () => {
  it("reads ANSI_936 from a Unix-newline DXF header", () => {
    assert.equal(readCadCodepage(dxfWithText("ANSI_936", utf8Bytes("x")), "dxf"), "ANSI_936");
  });

  it("reads a CRLF DXF header and uppercases the value", () => {
    const bytes = dxfWithText("ansi_936", utf8Bytes("x"), "\r\n");
    assert.equal(readCadCodepage(bytes, "dxf"), "ANSI_936");
  });

  it("returns null for a binary DXF, a non-CAD file, or a missing header", () => {
    const magic = utf8Bytes("AutoCAD Binary DXF\r\n\u001a\u0000");
    assert.equal(readCadCodepage(magic, "dxf"), null);
    assert.equal(readCadCodepage(utf8Bytes("  0\nSECTION\n  0\nEOF\n"), "geojson"), null);
    assert.equal(readCadCodepage(utf8Bytes("  0\nSECTION\n  0\nEOF\n"), "dxf"), null);
  });

  it("treats R2007+ DWG as UTF-8 and older DWG via an ANSI_* token", () => {
    assert.equal(readCadCodepage(dwgBytes("AC1021"), "dwg"), "UTF-8");
    assert.equal(readCadCodepage(dwgBytes("AC1018", "ANSI_936"), "dwg"), "ANSI_936");
    assert.equal(readCadCodepage(dwgBytes("AC1015"), "dwg"), null);
  });
});

describe("recodeCadString", () => {
  it("repairs GBK TEXT that WASM GDAL exposes as Latin-1", () => {
    assert.equal(recodeCadString(duckDbLatin1(GONGCHENG_GBK), "ANSI_936"), "工程名称");
    assert.equal(recodeCadString(duckDbLatin1(JIDIAN_GBK), "ANSI_936"), "集电线路");
    assert.equal(recodeCadString(duckDbLatin1(XINGYE_GBK), "ANSI_936"), "兴业大平山风电项目");
  });

  it("repairs the GBK multiplication sign shown as ¡Á in the attribute table", () => {
    const cable = concatBytes([utf8Bytes("ZC-YJLV22-26/35kV-3"), TIMES_GBK, utf8Bytes("95mm2")]);
    assert.equal(duckDbLatin1(TIMES_GBK), "¡Á");
    assert.equal(recodeCadString(duckDbLatin1(cable), "ANSI_936"), "ZC-YJLV22-26/35kV-3×95mm2");
  });

  it("repairs UTF-8 TEXT copied as Latin-1 (Ãæè mojibake after a UTF-8 rewrite)", () => {
    const utf8Times = duckDbLatin1(utf8Bytes("×"));
    assert.match(utf8Times, /Ã/);
    assert.equal(recodeCadString(utf8Times, "UTF-8"), "×");
    assert.equal(recodeCadString(duckDbLatin1(utf8Bytes("工程名称")), "UTF-8"), "工程名称");
  });

  it("leaves ASCII, already-Unicode, and unknown-codepage strings unchanged", () => {
    assert.equal(recodeCadString("XZ01", "ANSI_936"), "XZ01");
    assert.equal(recodeCadString("工程名称", "ANSI_936"), "工程名称");
    const mojibake = duckDbLatin1(GONGCHENG_GBK);
    assert.equal(recodeCadString(mojibake, null), mojibake);
    assert.equal(recodeCadString(mojibake, "ANSI_9999"), mojibake);
  });

  it("is idempotent after a successful GBK recode", () => {
    const once = recodeCadString(duckDbLatin1(GONGCHENG_GBK), "ANSI_936");
    assert.equal(recodeCadString(once, "ANSI_936"), "工程名称");
  });
});

describe("recodeCadFeatureCollection", () => {
  it("recodes Text and Layer on every feature", () => {
    const cable = concatBytes([utf8Bytes("ZC-YJLV22-26/35kV-3"), TIMES_GBK, utf8Bytes("95mm2")]);
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [
        textFeature({
          Text: duckDbLatin1(GONGCHENG_GBK),
          Layer: duckDbLatin1(JIDIAN_GBK),
          EntityHandle: "2A14",
          PaperSpace: 0,
        }),
        textFeature({ Text: duckDbLatin1(cable), Layer: "0" }),
      ],
    };
    const recoded = recodeCadFeatureCollection(collection, "ANSI_936");
    assert.equal(recoded.features[0]?.properties?.Text, "工程名称");
    assert.equal(recoded.features[0]?.properties?.Layer, "集电线路");
    assert.equal(recoded.features[0]?.properties?.EntityHandle, "2A14");
    assert.equal(recoded.features[1]?.properties?.Text, "ZC-YJLV22-26/35kV-3×95mm2");
  });

  it("returns the same collection when the codepage is missing", () => {
    const collection: FeatureCollection = {
      type: "FeatureCollection",
      features: [textFeature({ Text: duckDbLatin1(GONGCHENG_GBK) })],
    };
    assert.equal(recodeCadFeatureCollection(collection, null), collection);
  });
});
