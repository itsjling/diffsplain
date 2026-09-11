import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";

// Resolve the actual parser used by Blume, including any temporary alias.
const require = createRequire(import.meta.url);
const parser = createRequire(require.resolve("blume/package.json")).resolve("image-size");
const box = (name, bytes = Buffer.alloc(0), size = 8 + bytes.length) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size);
  header.write(name, 4);
  return Buffer.concat([header, Buffer.from(bytes)]);
};
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const jxlHeader = () => Buffer.concat([
  box("JXL ", [13, 10, 135, 10]),
  box("ftyp", Buffer.from("jxl ")),
]);

function measure(bytes) {
  // A node:test timeout cannot interrupt a synchronous parser infinite loop.
  const result = spawnSync(process.execPath, ["-e", `
    try {
      console.log(JSON.stringify(require(process.argv[1]).imageSize(Buffer.from(process.argv[2], "hex"))));
    } catch (error) {
      console.log(JSON.stringify({ error: error.message }));
    }
  `, parser, bytes.toString("hex")], { timeout: 3000, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const malformed = {
  ICNS: Buffer.from("69636e73000000106973333200000000", "hex"),
  JXL: Buffer.concat([jxlHeader(), box("jxlp", [0, 0, 0, 0], 0)]),
  HEIF: Buffer.from("00000010667479706176696600000000000000246d657461000000000000000869707270000000146970636f000000006973706500000000000000000000000000000000", "hex"),
};
for (const [format, bytes] of Object.entries(malformed)) {
  test(`image parser rejects non-advancing ${format} structures without hanging`, () => {
    assert.equal(typeof measure(bytes).error, "string");
  });
}

const controls = [
  ["ICNS", Buffer.from("69636e73000000106973333200000008", "hex"), 16, 16],
  ["JXL", Buffer.concat([jxlHeader(), box("jxlc", [255, 10, 1, 0])]), 8, 8],
  ["HEIF", Buffer.concat([
    box("ftyp", Buffer.from("avif0000")),
    box("meta", Buffer.concat([
      Buffer.alloc(4),
      box("iprp", box("ipco", box("ispe", Buffer.concat([Buffer.alloc(4), u32(32), u32(24)])))),
    ])),
  ]), 32, 24],
  ["PNG", Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64"), 1, 1],
  ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"></svg>'), 48, 24],
];
for (const [format, bytes, width, height] of controls) {
  test(`image parser preserves valid ${format} dimensions`, () => {
    const measured = measure(bytes);
    assert.equal(measured.width, width);
    assert.equal(measured.height, height);
  });
}
