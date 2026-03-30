module.exports = {
  apps: [
    {
      name: "bot",
      cwd: "/root/Traiding_KI_BOT/Bot_clean_server",
      script: "npm",
      args: "run start:bot",
      env: { NODE_ENV: "production" }
    },
    {
      name: "dashboard",
      cwd: "/root/Traiding_KI_BOT/Bot_clean_server",
      script: "npm",
      args: "run start:dashboard",
      env: { NODE_ENV: "production", PORT: "3000" }
    }
  ]
};
