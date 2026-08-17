// Compatibility barrel for code that imports the historical module path.
// Data ownership is now route-local; do not add a global provider here.
export { marketTodayKey, useEarnings } from "./useEarnings";
export { useSentiment } from "./useSentiment";
export { useXPosts } from "./useXPosts";
