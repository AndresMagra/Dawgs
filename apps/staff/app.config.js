// The staff website can live under a path (e.g. /staff) when one server hosts both apps.
module.exports = ({ config }) => ({
  ...config,
  experiments: { ...config.experiments, ...(process.env.EXPO_PUBLIC_BASE_URL ? { baseUrl: process.env.EXPO_PUBLIC_BASE_URL } : {}) },
});
