import { serializeJsonLd, type JsonLdDocument } from "@/lib/site/structured-data";

/** Structured data for search engines. A `type="application/ld+json"` script is a data block the
 *  browser never runs, so the CSP's script-src does not apply to it and it needs no nonce. */
export default function JsonLd({ data }: { data: JsonLdDocument }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serializeJsonLd(data) }}
    />
  );
}
