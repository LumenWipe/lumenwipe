import {
  shareImage,
  siteShareCard,
  SHARE_IMAGE_SIZE,
  SHARE_IMAGE_TYPE,
} from "@/components/seo/ShareImage";
import { shareImageFor } from "@/lib/site/pages";

export const alt = shareImageFor("en").alt;
export const size = SHARE_IMAGE_SIZE;
export const contentType = SHARE_IMAGE_TYPE;

export default function Image() {
  return shareImage(siteShareCard("en"));
}
