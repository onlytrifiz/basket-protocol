import { ShopSkeleton } from "../components/page-skeleton";

/* Inside the shop the layout already draws the header and the shop bar, so only the body waits. */
export default function Loading() {
  return <ShopSkeleton />;
}
