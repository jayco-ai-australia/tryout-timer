module.exports = {
  apps: [
    {
      name: "tryout-timer",
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
