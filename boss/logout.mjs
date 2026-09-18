/** 命令行解除插件绑定；不会退出或清理用户真实 Chrome 中的 Boss。 */
import { HOME_DIR } from "./lib.mjs";
import { logout } from "./loginflow.mjs";

console.log(`数据目录: ${HOME_DIR}`);
await logout();
console.log("✓ 已解除插件绑定。真实 Chrome 的 Boss cookie、简历库和岗位库均未改动。");
