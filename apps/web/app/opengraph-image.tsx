import { shareImage, SHARE_IMAGE_SIZE, SHARE_IMAGE_TYPE } from "@/components/seo/ShareImage";
import { SHARE_IMAGE } from "@/lib/site/pages";

export const alt = SHARE_IMAGE.alt;
export const size = SHARE_IMAGE_SIZE;
export const contentType = SHARE_IMAGE_TYPE;

export default function Image() {
  return shareImage({
    eyebrow: "Example account",
    headline: "Close the account. Keep the lumens.",
    plan: true,
  });
}
