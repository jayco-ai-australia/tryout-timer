/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath: '/jmotion',
  assetPrefix: '/jmotion',
  // Where `next build` writes and `next start` reads. Unset → `.next`, as before. Set only by
  // scripts/build-and-swap.sh, which builds into `.next-build` while the live server keeps serving
  // `.next`, then swaps the two. The running server never sets it, so it always reads `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
}

export default nextConfig
