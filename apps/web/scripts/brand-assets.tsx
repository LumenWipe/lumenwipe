// Writes every logo, icon and manifest file from brand/brand.ts. Run after changing it:
//   bun run brand:assets
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ImageResponse } from "next/og";
import {
  BRAND_PNGS,
  BRAND_SVGS,
  FAVICON_ICO_SIZES,
  MANIFEST_JSON,
  svgDataUri,
} from "@/brand/brand";

const WEB = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function write(path: string, data: string | Buffer): void {
  const target = join(WEB, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
}

async function png(svg: string, width: number, height: number): Promise<Buffer> {
  const image = new ImageResponse(
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img src={svgDataUri(svg)} width={width} height={height} />,
    { width, height }
  );
  return Buffer.from(await image.arrayBuffer());
}

/** An ICO file holding one PNG per size (supported by every browser since Windows Vista). */
function ico(images: { size: number; data: Buffer }[]): Buffer {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    header.writeUInt8(size % 256, entry);
    header.writeUInt8(size % 256, entry + 1);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((i) => i.data)]);
}

for (const [path, svg] of Object.entries(BRAND_SVGS)) write(path, svg);
for (const asset of BRAND_PNGS) write(asset.path, await png(asset.svg, asset.width, asset.height));
const favicon = BRAND_SVGS["public/favicon.svg"];
write(
  "public/favicon.ico",
  ico(
    await Promise.all(
      FAVICON_ICO_SIZES.map(async (size) => ({ size, data: await png(favicon, size, size) }))
    )
  )
);
write("public/site.webmanifest", MANIFEST_JSON);
