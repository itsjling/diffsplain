import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

const blume = join(
  dirname(fileURLToPath(import.meta.resolve("blume/package.json"))),
  "bin/blume.mjs"
);
const fixture = await mkdtemp(join(tmpdir(), "diffsplain-blume-audit-"));
after(() => rm(fixture, { force: true, recursive: true }));

const box = (name, bytes = Buffer.alloc(0), size = 8 + bytes.length) => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(size);
  header.write(name, 4);
  return Buffer.concat([header, Buffer.from(bytes)]);
};
const jxlHeader = () => Buffer.concat([
  box("JXL ", [13, 10, 135, 10]),
  box("ftyp", Buffer.from("jxl ")),
]);

const images = {
  "bad.heif": Buffer.from(
    "00000010667479706176696600000000000000246d657461000000000000000869707270000000146970636f000000006973706500000000000000000000000000000000",
    "hex"
  ),
  "bad.icns": Buffer.from("69636e73000000106973333200000000", "hex"),
  "bad.jxl": Buffer.concat([jxlHeader(), box("jxlp", [0, 0, 0, 0], 0)]),
  "small.png": Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=",
    "base64"
  ),
  "small.svg": Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24"></svg>'
  ),
};

await mkdir(join(fixture, "content"), { recursive: true });
await mkdir(join(fixture, "dist", "images"), { recursive: true });
await writeFile(
  join(fixture, "blume.config.mjs"),
  `export default {
    title: "Image audit fixture",
    description: "Checks image audit behavior.",
    content: { root: "content" },
    deployment: { output: "static", site: "https://example.com" },
  };\n`
);
await writeFile(join(fixture, "content", "index.mdx"), "# Image audit fixture\n");

for (const [name, bytes] of Object.entries(images)) {
  await writeFile(join(fixture, "dist", "images", name), bytes);
  await mkdir(join(fixture, "dist", name), { recursive: true });
  await writeFile(
    join(fixture, "dist", name, "index.html"),
    `<!doctype html><html lang="en"><head>
      <title>${name}</title>
      <meta property="og:image" content="/images/${name}">
    </head><body><main>${name}</main></body></html>\n`
  );
}

test("Blume audits image dimensions and handles malformed images without hanging", () => {
  // A node:test timeout cannot interrupt a synchronous parser infinite loop.
  const result = spawnSync(
    process.execPath,
    [blume, "audit", "--only", "BLUME_AUDIT_OG_IMAGE_SMALL", "--json"],
    {
      cwd: fixture,
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 10_000,
    }
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.audit.pages, Object.keys(images).length);
  const findings = report.diagnostics.filter(
    ({ code }) => code === "BLUME_AUDIT_OG_IMAGE_SMALL"
  );
  assert.equal(findings.length, 2);
  const messages = findings.map(({ message }) => message).join("\n");
  assert.match(messages, /small\.png is 1×1/u);
  assert.match(messages, /small\.svg is 48×24/u);
});
