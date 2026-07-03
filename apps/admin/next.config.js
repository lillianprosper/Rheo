/** @type {import('next').NextConfig} */
const nextConfig = {
  // 'output: standalone' removed — it is a Docker/self-host packaging mode.
  // On Vercel it causes routes to compile into the build but 404 at serve time.
  // Vercel manages its own build output; no `output` setting is needed.
  reactStrictMode: true,
}

module.exports = nextConfig
