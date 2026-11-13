"use client";

import { ProductSite } from "@/components/ProductSite";

export default function SitePage({ params }: { params: Promise<{ slug: string }> }) {
  return <ProductSite params={params} />;
}
