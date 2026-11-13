import BoardPage from "./board-page";
import { ProductSite } from "@/components/ProductSite";

export const dynamic = "force-dynamic";

const SITES = new Set(["ledger", "switchboard", "hopper", "relay"]);

export default function Home() {
  const slug = process.env.SITE_SLUG || process.env.NEXT_PUBLIC_SITE_SLUG || "";
  if (SITES.has(slug)) return <ProductSite params={Promise.resolve({ slug })} initialSlug={slug} />;
  return <BoardPage />;
}
