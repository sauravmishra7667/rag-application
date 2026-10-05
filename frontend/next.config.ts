import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // A self-contained server bundle, used by the Docker image.
  output: "standalone",
};

export default config;
