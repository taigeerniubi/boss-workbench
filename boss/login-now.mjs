/** 命令行登录：复用 9222 中的真实 Chrome，会话检测只读 cookie，最后校验一次。 */
import { pollLogin, startLogin } from "./loginflow.mjs";

const started = await startLogin({ force: true });
if (!started.ok) {
	console.error(`✗ ${started.error ?? started.phase}`);
	console.error("请先用 --remote-debugging-port=9222 启动 Chrome，并在其中打开 Boss。 ");
	process.exit(1);
}
if (started.phase === "logged-in") {
	console.log(`✓ 已绑定当前 Chrome 的 Boss 会话${started.account ? `（${started.account}）` : ""}`);
	process.exit(0);
}

console.log("已连接 Chrome。请在刚打开/已有的 Boss 标签中扫码并完成手机确认。");
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline) {
	await new Promise((resolve) => setTimeout(resolve, 2000));
	const state = await pollLogin();
	if (state.phase === "logged-in") {
		console.log(`✓ 已绑定当前 Chrome 的 Boss 会话${state.account ? `（${state.account}）` : ""}`);
		process.exit(0);
	}
	if (["browser-unavailable", "ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited", "expired", "failed"].includes(state.phase)) {
		console.error(`✗ ${state.phase}: ${state.error ?? ""}`);
		process.exit(2);
	}
}
console.error("✗ 等待登录超时");
process.exit(3);
