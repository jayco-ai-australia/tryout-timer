module.exports = {
  apps: [
    {
      name: "j-motion",
      script: "node_modules/.bin/next",
      args: "start",
      cwd: "/Users/jaycoai/Projects/tryout-timer",
      env: {
        NODE_ENV: "production",
        PORT: 3001,
      },
    },
  ],
};
