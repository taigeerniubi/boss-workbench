// 兼容旧入口；实现统一放在 login-now.mjs，避免两套登录逻辑分叉。
await import("./login-now.mjs");
