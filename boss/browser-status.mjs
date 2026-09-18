/** 只检查本机 CDP 与 cookie，不向 Boss 发送网络请求。 */
import { existingBrowserStatus } from "./browser-channel.mjs";

const status = await existingBrowserStatus();
console.log(JSON.stringify(status, null, 2));
process.exit(status.ok && status.loggedIn && status.hasPage ? 0 : 1);
