window.__ModuleLoader__.load({
	id: "dsh-boss-workbench",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		let react = require("react");

		/**
		 * 面板标题。它同时是两个地方的锚点：sidebar 里那一行的文案，
		 * 以及插件用来命中"自己那一行"的 CSS 选择器（见样式末尾的对齐段）。
		 */
		const PANEL_LABEL = "Boss 工作台";

		//#region styles
		const css = `
.bw_page{position:relative;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-module-platform,#f5f6f7);color:var(--dsw-alias-label-primary,#0f1115)}
.bw_head{display:flex;align-items:center;gap:12px;padding:10px 16px;background:var(--dsw-alias-bg-layer-1,#fff);border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.bw_title{font-size:14px;font-weight:600;letter-spacing:.01em}
.bw_btn{height:28px;padding:0 11px;font:inherit;font-size:12.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid transparent;border-radius:8px;cursor:pointer;white-space:nowrap}
.bw_btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.bw_btnPrimary{color:#fff;background:var(--dsw-alias-brand-primary,#0f1115)}
.bw_btnPrimary:hover{color:#fff;background:var(--dsw-alias-brand-primary,#0f1115);filter:brightness(1.3)}
.bw_btnDanger{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent)}
.bw_btnDanger:hover{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 22%,transparent)}
/* 「去 Boss 拿数据」这一类主动作 —— 整个工作台里唯一会真的联网的按钮 */
.bw_btnGo{color:#fff;background:var(--dsw-alias-state-business-primary,#4176e6)}
.bw_btnGo:hover{color:#fff;background:var(--dsw-alias-state-business-primary,#4176e6);filter:brightness(1.12)}
.bw_btnGo:disabled,.bw_btnBusy{opacity:.6;cursor:progress}
.bw_btnGo:disabled:hover{filter:none}
.bw_btnBusy{color:#fff;background:var(--dsw-alias-state-business-primary,#4176e6)}
/* 冷却期：按钮看着就"别按" */
.bw_btnCold,.bw_btnCold:hover{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);filter:none;cursor:not-allowed}
.bw_spacer{flex:1}

/* 顶部三个计数 = 状态筛选段控件（点一下筛，再点一下取消） */
.bw_tallies{display:inline-flex;align-items:center;gap:2px;padding:2px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;flex:none}
.bw_tally{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:0;border-radius:7px;cursor:pointer;white-space:nowrap;font-variant-numeric:tabular-nums}
.bw_tally:hover{color:var(--dsw-alias-label-primary)}
.bw_tallyHot{color:var(--dsw-alias-state-warn-label,#dd8629)}
.bw_tallyOn{color:var(--dsw-alias-label-primary);font-weight:600;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px #00000014}
.bw_tallyOn.bw_tallyHot{color:var(--dsw-alias-state-warn-label,#dd8629)}
.bw_dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}

/* 三栏 = 三张圆角面板，画在浅色画布上，靠底色 + 间距 + 描边三重分界 */
.bw_cols{flex:1;display:grid;grid-template-columns:minmax(240px,264px) minmax(340px,1fr) minmax(266px,300px);gap:10px;padding:10px 12px 12px;min-height:0}
.bw_col{display:flex;flex-direction:column;min-height:0;min-width:0;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden}
.bw_colMid{border-color:var(--dsw-alias-border-l3)}
.bw_colHead{display:flex;align-items:center;gap:6px;padding:9px 12px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.bw_scroll{flex:1;overflow-y:auto;min-height:0;position:relative}
.bw_tag{display:inline-flex;align-items:center;gap:2px;height:17px;padding:0 4px 0 6px;font-size:10px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l2);border-radius:5px}
.bw_tagX{width:14px;height:14px;padding:0;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;border-radius:4px;cursor:pointer}
.bw_tagX:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}

.bw_group{padding:6px 8px 4px}
.bw_group+.bw_group{border-top:1px solid var(--dsw-alias-border-l2)}
.bw_groupHead{display:flex;align-items:center;gap:6px;padding:3px 4px 6px;font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary)}
.bw_groupHot{color:var(--dsw-alias-state-warn-label,#dd8629)}
.bw_groupN{margin-left:auto;font-variant-numeric:tabular-nums}
.bw_card{display:block;width:100%;text-align:left;box-sizing:border-box;padding:8px 10px;margin-bottom:4px;background:transparent;border:1px solid transparent;border-radius:9px;cursor:pointer;color:inherit;font:inherit;outline:none}
.bw_card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bw_card:focus-visible{border-color:var(--dsw-alias-border-l4)}
.bw_cardOn{background:var(--dsw-alias-bg-module-platform,#f5f6f7);border-color:var(--dsw-alias-border-l3)}
.bw_cardTop{display:flex;align-items:baseline;gap:6px;min-width:0}
.bw_co{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bw_sal{margin-left:auto;font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}
.bw_role{font-size:12px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:1px}
.bw_meta{display:flex;align-items:center;gap:6px;margin-top:5px;min-width:0}
.bw_chip{display:inline-flex;align-items:center;gap:4px;height:17px;padding:0 6px;font:inherit;font-size:10.5px;border:0;border-radius:5px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bw_chipHot{background:var(--dsw-alias-state-warn-tertiary,#fef5e7);color:var(--dsw-alias-state-warn-label,#dd8629)}
.bw_chipOk{background:var(--dsw-alias-state-success-tertiary,#e6faed);color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 68%,#0f1115)}
.bw_chipBad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 88%,#0f1115)}
.bw_chipBrand{background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 12%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 90%,#0f1115)}
/* 状态标签可点：点它就是"按这个状态看 + 跳到这个状态该做的事" */
.bw_chipBtn{cursor:pointer;box-shadow:inset 0 0 0 1px transparent}
.bw_chipBtn:hover{box-shadow:inset 0 0 0 1px color-mix(in srgb,currentColor 50%,transparent)}

.bw_detail{padding:14px 16px 18px}
.bw_dTitle{font-size:16px;font-weight:650;letter-spacing:.01em}
.bw_dSub{margin-top:3px;font-size:12.5px;color:var(--dsw-alias-label-tertiary)}
.bw_sect{margin-top:16px}
.bw_sectHead{display:flex;align-items:center;gap:8px;margin-bottom:6px;font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.bw_jd{box-sizing:border-box;padding:11px 12px;font-size:12.5px;line-height:1.65;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;max-height:230px;overflow-y:auto}
.bw_pick{display:flex;align-items:center;gap:8px;box-sizing:border-box;padding:8px 10px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.bw_pickFile{display:flex;align-items:center;gap:7px;min-width:0;font-size:12.5px;font-family:var(--dsw-font-markdown-code-font-family,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace)}
.bw_pickName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bw_pickNote{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-left:auto;flex:none}
.bw_ta{box-sizing:border-box;width:100%;min-height:80px;padding:10px 11px;font:inherit;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;outline:none;resize:vertical}
.bw_ta:focus{border-color:var(--dsw-alias-border-l4)}
/* 这个状态要我做什么 —— 三种"需要我"的状态在这里各自说明并给出主行动 */
.bw_note{display:flex;align-items:flex-start;gap:8px;box-sizing:border-box;padding:9px 11px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l1);border-radius:10px}
.bw_noteWarn{color:color-mix(in srgb,var(--dsw-alias-state-warn-label,#dd8629) 82%,#0f1115);background:var(--dsw-alias-state-warn-tertiary,#fef5e7);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f59e0b) 26%,transparent)}
.bw_noteOk{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 66%,#0f1115);background:var(--dsw-alias-state-success-tertiary,#e6faed);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 26%,transparent)}
.bw_noteBad{color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 84%,#0f1115);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 10%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 24%,transparent)}
.bw_noteBusy{color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 86%,#0f1115);background:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 9%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 24%,transparent)}
.bw_noteMuted{color:var(--dsw-alias-label-tertiary)}
/* 动作行常驻面板底部：这个状态要你做的事永远在视野里，不会滚出屏幕 */
.bw_foot{flex:none;padding:11px 16px 13px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#fff)}
.bw_actions{display:flex;align-items:center;gap:8px;margin-top:11px;border-radius:10px}
.bw_actionsFocus{animation:bwPulse 1s ease-out 1}
@keyframes bwPulse{0%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 45%,transparent)}100%{box-shadow:0 0 0 12px transparent}}

.bw_tl{position:relative;padding-left:14px}
.bw_tlItem{position:relative;padding-bottom:11px}
.bw_tlItem:before{content:"";position:absolute;left:-14px;top:5px;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.55}
.bw_tlHot:before{background:var(--dsw-alias-state-warn-primary,#f59e0b);opacity:1}
.bw_tlItem:after{content:"";position:absolute;left:-11.5px;top:13px;bottom:0;width:1px;background:var(--dsw-alias-border-l2)}
.bw_tlItem:last-child:after{display:none}
.bw_tlTime{font-size:10.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bw_tlText{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:1px}
.bw_kv{display:flex;align-items:center;gap:8px;font-size:12px;padding:5px 0}
.bw_kvK{color:var(--dsw-alias-label-tertiary);flex:none;min-width:52px}
.bw_kvV{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bw_hr{height:1px;background:var(--dsw-alias-border-l2);margin:14px 0}
.bw_empty{padding:18px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);text-align:center}
.bw_emptyAct{margin-top:10px;display:flex;justify-content:center}

.bw_toasts{position:fixed;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;pointer-events:none;z-index:200}
.bw_toast{pointer-events:auto;display:flex;align-items:flex-start;gap:9px;box-sizing:border-box;width:320px;padding:10px 11px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.18))}
.bw_toastBody{min-width:0;flex:1}
.bw_toastTitle{font-size:12.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bw_toastText{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-top:2px}
.bw_toastAct{margin-top:8px;display:flex;gap:6px}
.bw_toastX{flex:none;width:20px;height:20px;padding:0;font-size:14px;line-height:1;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;border-radius:5px;cursor:pointer}
.bw_toastX:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}

/* ── 抓取条件条：城市 / 岗位关键词 / 距离 ──────────────────────────────────
   和「需要我 / 等待回复」那组段控件刻意分开：那组回答"现在处理谁"（triage），
   这组回答"抓什么"（query）。两者语义不同，混在一行会互相干扰。 */
.bw_filters{display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#fff);flex:none;overflow:hidden}
.bw_field{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 9px;font-size:12.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid transparent;border-radius:8px;flex:none}
.bw_field:focus-within{border-color:var(--dsw-alias-border-l4)}
.bw_fieldK{color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.bw_select,.bw_kw{font:inherit;font-size:12.5px;color:var(--dsw-alias-label-primary);background:transparent;border:0;outline:none}
.bw_select{cursor:pointer;max-width:132px}
.bw_kw{width:190px}
/* 输入框右边那颗「搜」：回车和点它做的是同一件事 */
.bw_kwGo{flex:none;height:20px;padding:0 9px;font:inherit;font-size:11.5px;color:#fff;background:var(--dsw-alias-state-business-primary,#4176e6);border:0;border-radius:6px;cursor:pointer}
.bw_kwGo:hover{filter:brightness(1.12)}
.bw_kwGo:disabled{opacity:.6;cursor:progress}
.bw_count{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;flex:none}
/* 抓取进度 / 结果条。错误（尤其是风控与登录失效）必须一眼看到 */
.bw_scrape{display:flex;align-items:center;gap:7px;padding:0 14px;height:26px;font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border-bottom:.5px solid var(--dsw-alias-border-l2)}
.bw_scrapeDot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}
.bw_scrapeOk .bw_scrapeDot{background:var(--dsw-alias-state-success-primary,#22c55e)}
.bw_scrapeBad{color:var(--dsw-alias-state-error-primary,#ec1313);background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ec1313) 8%,transparent)}
.bw_scrapeBad .bw_scrapeDot{background:var(--dsw-alias-state-error-primary,#ec1313)}
.bw_demoTag{flex:none;padding:1px 6px;margin-right:4px;font-size:10.5px;color:var(--dsw-alias-label-tertiary);border:.5px dashed var(--dsw-alias-border-l3);border-radius:5px}
/* 退出登录：低调，但要在表头找得到 */
.bw_logout{flex:none;margin-left:8px;height:24px;padding:0 9px;font:inherit;font-size:11.5px;color:var(--dsw-alias-label-tertiary);background:transparent;border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;cursor:pointer;white-space:nowrap}
.bw_logout:hover{color:var(--dsw-alias-state-error-primary,#ec1313);border-color:var(--dsw-alias-state-error-primary,#ec1313)}
.bw_logout:disabled{opacity:.6;cursor:progress}
.bw_emptyActs{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}

/* 卡片上的地点行：城市·商圈 + 距你多远 */
.bw_cardLoc{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:0}
.bw_locText{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.bw_locDist{margin-left:auto;flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.bw_locNear{color:color-mix(in srgb,var(--dsw-alias-state-business-primary,#4176e6) 88%,#0f1115);font-weight:600}
.bw_locUnknown{font-style:italic}

/* ── 登录闸门：进工作台时没登录就把二维码顶上来 ─────────────────────────── */
.bw_gate{position:absolute;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:color-mix(in srgb,var(--dsw-alias-bg-mask-1,#0000003d) 70%,transparent)}
.bw_gateCard{box-sizing:border-box;width:320px;padding:18px 20px 16px;border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);border:1px solid var(--dsw-alias-border-l2);box-shadow:var(--dsw-elevation-prominent,0 8px 28px rgba(0,0,0,.18));text-align:center}
.bw_gateTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.bw_gateSub{margin-top:4px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.bw_gateQr{margin:12px auto 0;width:180px;height:180px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden}
.bw_gateQrImg{width:100%;height:100%;object-fit:contain}
.bw_gatePhase{margin-top:10px;font-size:12.5px;color:var(--dsw-alias-label-secondary);min-height:18px}
.bw_gateDetail{margin-top:4px;font-size:11.5px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.bw_gateHot{color:var(--dsw-alias-state-warn-label,#dd8629)}
.bw_gateBad{color:var(--dsw-alias-state-error-primary,#ec1313)}
.bw_gateOk{color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 70%,#0f1115)}
.bw_gateActs{margin-top:12px;display:flex;gap:8px;justify-content:center}
.bw_spin{display:inline-block;width:11px;height:11px;border:1.5px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary,#4176e6);border-radius:50%;animation:bwSpin .8s linear infinite;vertical-align:-1px;margin-right:5px}
@keyframes bwSpin{to{transform:rotate(360deg)}}

/* ── 余额：账号还剩多少钱 ────────────────────────────────────────────────── */
.bw_bal{display:inline-flex;align-items:center;height:26px;padding:0 10px;border-radius:9px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
/* 会话区右下角：和 shell 自己的「用量 · 缓存命中」同一处。dock 是竖着排的，
   所以这颗会落在那一行的正下方 —— width:100% + flex-end 让它贴右，
   看起来就和「用量 · 缓存命中」同属右下角那一簇。 */
.bw_balDock{width:100%;box-sizing:border-box;display:flex;justify-content:flex-end;padding:0 2px 2px}
.bw_balPill{display:inline-flex;align-items:center;height:22px;padding:0 9px;border-radius:999px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px solid var(--dsw-alias-border-l2);font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-variant-numeric:tabular-nums}
.bw_balWait{opacity:.65}
.bw_balLow{color:var(--dsw-alias-state-error-primary,#ec1313)}

/* ── 简历库 ────────────────────────────────────────────────────────────────
   简历是**全局**的，所以它不能挂在"当前 JD"那块里 —— 右栏用两个面板叠起来：
   上面「这个 JD 的进展」跟着选中项走，下面「简历库」永远在（可整体折叠）。 */
.bw_colStack{display:flex;flex-direction:column;gap:10px;min-height:0;min-width:0}
/* 两个面板平分右栏高度；收起简历库时它退回"只有一条标题栏" */
.bw_colStack > .bw_col{flex:1 1 0;min-height:0}
.bw_colStack > .bw_colLibOff{flex:0 0 auto}
.bw_colLib{flex:1 1 0}
.bw_libBar{display:flex;align-items:center;gap:6px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--dsw-alias-border-l2);flex:none}
.bw_libTitle{font-size:11px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.bw_libN{font-size:11px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}
.bw_libBody{flex:1;overflow-y:auto;min-height:0;padding:8px}
.bw_drop{margin:0 2px 8px;padding:13px 10px;text-align:center;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-module-platform,#f5f6f7);border:1px dashed var(--dsw-alias-border-l3);border-radius:10px}
.bw_dropHot{border-color:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary)}
.bw_dropAct{color:var(--dsw-alias-state-business-primary,#4176e6);cursor:pointer;text-decoration:underline;background:transparent;border:0;font:inherit;padding:0}
.bw_rw{margin-bottom:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;overflow:hidden}
.bw_rwOn{border-color:var(--dsw-alias-border-l3)}
.bw_rwHead{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:7px 8px;background:transparent;border:0;cursor:pointer;text-align:left;color:inherit;font:inherit}
.bw_rwHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.bw_rwOn .bw_rwHead{background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.bw_rwName{font-size:12px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.bw_rwCaret{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
.bw_libErr{margin:0 0 6px;padding:6px 8px;font-size:12px;border-radius:7px;color:var(--dsw-alias-state-error-primary,#ec1313);background:var(--dsw-alias-bg-module-platform,#f5f6f7)}
.bw_rwX{flex:none;width:18px;height:18px;padding:0;font-size:13px;line-height:1;color:var(--dsw-alias-label-tertiary);background:transparent;border:0;border-radius:5px;cursor:pointer}
.bw_rwX:hover{color:var(--dsw-alias-state-error-primary,#ec1313);background:var(--dsw-alias-interactive-bg-hover)}
.bw_rwBody{padding:2px 9px 9px;border-top:1px solid var(--dsw-alias-border-l1)}
.bw_kv2{display:flex;gap:6px;font-size:11.5px;padding:3px 0;align-items:baseline}
.bw_kv2K{color:var(--dsw-alias-label-tertiary);flex:none;min-width:38px}
.bw_kv2V{color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word}
.bw_skills{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px}
.bw_skill{font-size:10.5px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-bg-module-platform,#f5f6f7);color:var(--dsw-alias-label-secondary)}
.bw_skillHit{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 14%,transparent);color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 70%,#0f1115)}
.bw_bar{height:3px;border-radius:2px;background:var(--dsw-alias-border-l2);overflow:hidden;margin-top:5px}
.bw_barFill{height:100%;background:var(--dsw-alias-state-business-primary,#4176e6);transition:width .15s linear}
.bw_barDone{background:var(--dsw-alias-state-success-primary,#22c55e)}
.bw_barBad{background:var(--dsw-alias-state-error-primary,#ec1313)}
.bw_upRow{display:flex;flex-direction:column;gap:2px;padding:4px 2px}
.bw_upTop{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.bw_upName{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bw_upPct{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}

/* ── 与 shell 对齐：让侧栏里「Boss 工作台」这一行和新会话同款 ────────────────
   这一行的外壳（button 元素 + 它的样式）归 ui-sidebar 所有，插件只提供图标，
   所以只能靠 aria-label 命中自己那一行来做视觉对齐（下面所有选择器都带这个
   aria-label，不会碰到别人的行）。
   宽栏时行内是「图标 span + 标题 span」，收成轨道时只剩图标 span —— 用 :has()
   只对宽栏套用新会话那套尺寸，轨道形态原样交还给 shell。
   取的是 ui-sidebar 里 .newSession 的真实取值；active 保留一个更深的填充，
   否则「哪个面板开着」就看不出来了。 */
button[aria-label="${PANEL_LABEL}"]:has(> span + span){box-sizing:border-box;height:38px;margin:0 2px 8px;padding:8px 16px;justify-content:center;gap:6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:12px;background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:22px;overflow:hidden}
button[aria-label="${PANEL_LABEL}"]:has(> span + span):hover{background:var(--dsw-alias-button-floating-hover)}
button[aria-label="${PANEL_LABEL}"]:has(> span + span)[aria-current="page"]{background:var(--dsw-alias-interactive-bg-active);border-color:var(--dsw-alias-border-l4)}
button[aria-label="${PANEL_LABEL}"]:not(:has(> span + span)){box-sizing:border-box;width:36px;height:36px;margin:0;padding:0;border:0;border-radius:8px;background:transparent;justify-content:center}
`;
		const tagId = "dsh-boss-workbench/Workbench.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-boss-workbench";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		//#endregion

		const h = react.createElement;

		//#region 状态机定义 —— 整个 UI 的骨架
		/**
		 * 投递流水线的状态。`hot` 标记的三个状态是"阻塞在人类这里"的状态，
		 * 它们是排序、分组、提醒的最高优先级来源。
		 */
		const STATUS = {
			new: { label: "待处理", chip: "" },
			preparing: { label: "定制中", chip: "bw_chipBrand" },
			review: { label: "待你确认", chip: "bw_chipHot", hot: true },
			sending: { label: "发送中", chip: "bw_chipBrand" },
			sent: { label: "等待回复", chip: "" },
			replied: { label: "已回复", chip: "bw_chipOk", hot: true },
			failed: { label: "失败", chip: "bw_chipBad", hot: true },
			skipped: { label: "已跳过", chip: "" },
		};

		/** 队列分组：先给"需要我"，再给进行中，最后是等结果与已结束。 */
		const GROUPS = [
			{ key: "hot", title: "需要我", hot: true, match: (a) => STATUS[a.status].hot },
			{ key: "active", title: "进行中", match: (a) => a.status === "new" || a.status === "preparing" || a.status === "sending" },
			{ key: "waiting", title: "等待回复", match: (a) => a.status === "sent" },
			{ key: "done", title: "已结束", match: (a) => a.status === "skipped" },
		];

		const groupOf = (a) => GROUPS.find((g) => g.match(a));

		/** 待确认优先，其次失败，最后待回话 —— 先处理能推进的。 */
		const HOT_RANK = { review: 0, failed: 1, replied: 2 };
		const byUrgency = (l, r) => (HOT_RANK[l.status] ?? 9) - (HOT_RANK[r.status] ?? 9) || l.at - r.at;

		/**
		 * 顶部三个计数就是三档筛选：`needs` / `waiting` 是聚合档，`null` 是全部。
		 * 卡片上的状态标签点了会落成该状态本身（如 `review`）—— 同一套筛选语义。
		 */
		const FILTERS = {
			needs: { label: "需要我", match: (a) => STATUS[a.status].hot },
			waiting: { label: "等待回复", match: (a) => a.status === "sent" },
		};
		const matchFilter = (f) => (f === null ? () => true : (FILTERS[f]?.match ?? ((a) => a.status === f)));
		const labelFilter = (f) => (f === null ? null : (FILTERS[f]?.label ?? STATUS[f].label));

		/** 距离档位：km = 上限；null = 不限。 */
		const DISTANCE_OPTIONS = [
			{ km: null, label: "不限" },
			{ km: 3, label: "3km 内" },
			{ km: 5, label: "5km 内" },
			{ km: 10, label: "10km 内" },
		];

		/**
		 * 抓取条件（城市 / 岗位关键词 / 距离 / 七个 Boss 维度）与状态筛选合成后的判定。
		 * 和 boss/lib.mjs 里的 filterJobs 是同一套语义：那边给 agent 读，
		 * 这边给 UI 用；两边一起改，别让"看到什么"和"agent 拿到什么"分叉。
		 *
		 * ⚠️ 之前这里的 `jobFilters` 参数根本不存在 —— 七个下拉框只写进了 remote，
		 * 没人读，于是"选了行业"看起来没反应。筛选项必须在这里真的参与判定。
		 */
		function jobMatches(app, { filter = null, city = null, kw = "", maxKm = null, jobFilters = {} } = {}) {
			if (!matchFilter(filter)(app)) return false;
			if (city !== null && app.city !== city) return false;
			// 距离筛选会把"距离未知"的同城岗位一起筛掉 —— 宁缺勿错
			if (maxKm !== null && (app.distanceKm === null || app.distanceKm > maxKm)) return false;
			// 七个维度：抓取时已经按服务端筛过一遍，这里再按**本地字段**复核一次。
			//
			// 两条语义，都是"没证据就别筛掉"：
			//   1. 岗位这条**没给**这个字段（老数据 / 推荐流没返回规模）→ 放行，别误杀；
			//   2. 岗位给了值 → 必须真的命中。
			// 反过来（缺字段就筛掉）在实机上表现为"选了规模，整页全空"。
			if (jobFilters.salary && !salaryInRange(app.salary, jobFilters.salary)) return false;			if (jobFilters.experience && app.experienceName && !labelMatches(jobFilters.experience, app.experienceName)) return false;
			if (jobFilters.degree && app.degreeName && !labelMatches(jobFilters.degree, app.degreeName)) return false;
			if (jobFilters.jobType && app.jobType && !labelMatches(jobFilters.jobType, app.jobType)) return false;
			if (jobFilters.industry && app.industry && !labelMatches(jobFilters.industry, app.industry)) return false;
			if (jobFilters.scale && app.scale && !labelMatches(jobFilters.scale, app.scale)) return false;
			if (jobFilters.stage && app.stage && !labelMatches(jobFilters.stage, app.stage)) return false;
			const needle = kw.trim().toLowerCase();
			if (needle !== "") {
				const hay = `${app.company} ${app.title} ${app.jd} ${app.area ?? ""} ${app.industry ?? ""}`.toLowerCase();
				if (!hay.includes(needle)) return false;
			}
			return true;
		}

		/** 薪资档位 → [下限, 上限]（单位 K，null = 无界）。用来把岗位的"20-40K"塞进用户选的档位。 */
		const SALARY_BANDS = {
			"3K以下": [null, 3], "3-5K": [3, 5], "5-10K": [5, 10], "10-15K": [10, 15],
			"15-20K": [15, 20], "20-30K": [20, 30], "30-50K": [30, 50], "50K以上": [50, null],
		};
		/**
		 * 薪资筛选：**岗位薪资下限必须落在用户选的档位里**。
		 *
		 * 为什么不是"区间相交"：Boss 的档位是相邻的（20-30K 与 30-50K 共享端点），
		 * 而岗位写的是实际区间（"25-40K"）—— 用相交判，25-40K 会同时命中
		 * 20-30K 和 30-50K，等于选什么都没筛掉，下拉框又变成摆设。
		 *
		 * 也不用"岗位下限 ≥ 档位下限"：那样选 20-30K 会把 20-30K 的岗位自己筛掉。
		 *
		 * 现在的语义干净且可预测：
		 *   岗位 20-30K → 下限 20，落在 [20,30] → 命中「20-30K」
		 *   岗位 25-40K → 下限 25，落在 [20,30] → 命中「20-30K」（起薪确实在这个区间）
		 *   岗位 30-50K → 下限 30，超出 [20,30] 的上界 → 不命中「20-30K」，命中「30-50K」
		 * 解析不出数字（"面议"）时**放行** —— 没有证据就别筛掉，服务端已经筛过一轮了。
		 */
		function salaryInRange(text, label) {
			const band = SALARY_BANDS[label];
			if (band === undefined) return true;
			const numbers = String(text ?? "").match(/\d+(?:\.\d+)?/gu);
			if (numbers === null || numbers.length === 0) return true;
			const low = Number(numbers[0]);
			const [bandLow, bandHigh] = band;
			if (bandLow !== null && low < bandLow) return false;
			if (bandHigh !== null && low > bandHigh) return false;
			return true;
		}

		/**
		 * 一个筛选项标签 vs 岗位上的原值：宽松匹配。
		 * 「3-5年」要能匹配到「3-5年」，也要能匹配到「经验不限」之外的写法；
		 * 只要岗位值里**含有**标签（或反过来），就算命中。
		 */
		function labelMatches(label, value) {
			if (!label || label === "不限") return true;
			const a = String(label);
			const b = String(value ?? "");
			return b === a || b.includes(a) || a.includes(b);
		}

		/** 卡片右侧那一格：同城给距离，异地给"异地"，同城没坐标给"距离未知"。 */
		function distanceLabel(app) {
			if (app.sameCity === false) return "异地";
			if (app.distanceKm === null || app.distanceKm === undefined) return "距离未知";
			return app.distanceKm.toFixed(1) + "km";
		}
		function distanceClass(app, nearKm) {
			if (app.sameCity === false || app.distanceKm === null || app.distanceKm === undefined) return "bw_locDist bw_locUnknown";
			return app.distanceKm <= nearKm ? "bw_locDist bw_locNear" : "bw_locDist";
		}

		/**
		 * 每个状态"要我做什么"。三种 hot 状态在 UI 上各自有一条彩色说明带 +
		 * 一个主行动，其余状态只有说明 —— 这样"点一个状态"永远有下一步。
		 */
		const STATE_NOTE = {
			new: ["", "新抓到的岗位。先选一份简历，再按 JD 润色简历与话术。"],
			preparing: ["Busy", "正在按 JD 润色结构化简历；做完会停下来等你确认。"],
			review: ["Warn", "简历润色结果与话术已就绪。发送前由你按确认 —— 这是自动化误发的保险丝。"],
			sending: ["Busy", "正在把打招呼语发给对方，稍等几秒。"],
			sent: ["", "已送达，等招聘者回复。对方回话会推到提醒里。"],
			replied: ["Ok", "招聘者回复了你。回复率随时间衰减，建议尽快回话。"],
			failed: ["Bad", "发送失败，常见原因是登录态失效或撞了风控。看清楚原因再决定要不要重试。"],
			skipped: ["Muted", "你跳过了这个岗位，已归档。"],
		};

		/** 三种「阻塞在人类这里」的状态各自唯一的主动作。 */
		const PRIMARY = {
			review: { label: "就这样，发送 ▸", run: "send" },
			failed: { label: "查看并重试", run: "retry" },
			replied: { label: "去回话 ▸", run: "reply" },
		};

		/** 本地简历库（演示兜底）：宿主还没起来时「换」也有下一份可换。 */
		const RESUMES = ["后端_通用_v2.pdf", "后端_中科智联_v3.pdf", "全栈_通用_v1.pdf", "Go后端_启明_v2.pdf"];

		/** 点击产生的每个状态迁移都补一条"刚刚"的时间线。 */
		const stamp = () => new Date().toTimeString().slice(0, 5);
		//#endregion

		//#region 假数据 —— 阶段 0 用它把布局画出来，便于评审
		const MOCK = [
			{
				id: "j1", company: "中科智联", title: "后端工程师", salary: "25-40K", city: "北京 · 3-5年",
				status: "review", resume: "后端_中科智联_v3.pdf", hr: "李女士", at: 3,
				jd: "岗位职责：\n1. 负责核心交易系统的后端设计与开发，保障高并发下的稳定性；\n2. 参与架构演进，推动服务拆分与性能优化；\n3. 与产品、前端协作完成需求交付。\n\n任职要求：\n1. 本科及以上学历，3 年以上 Java 开发经验；\n2. 熟悉 Spring Cloud、MySQL、Redis，了解消息队列；\n3. 有高并发或分布式系统经验者优先。",
				greeting: "您好，看到贵司在招后端工程师。我有 4 年交易系统开发经验，主导过日均千万级订单的服务拆分，与岗位要求的高并发方向比较契合，想和您详细聊聊。",
				timeline: [["10:02", "抓取岗位", 0], ["10:03", "agent 按 JD 定制简历", 0], ["10:05", "简历与话术就绪，等你确认", 1]],
			},
			{
				id: "j2", company: "某某网络", title: "前端开发工程师", salary: "20-35K", city: "杭州 · 3-5年",
				status: "failed", resume: "前端_通用_v2.pdf", hr: "王先生", at: 8,
				jd: "岗位职责：\n1. 负责 C 端产品的前端开发与体验优化；\n2. 推动组件库建设与工程化改进。\n\n任职要求：\n1. 熟练掌握 TypeScript 与主流框架；\n2. 有性能优化与可视化经验者优先。",
				greeting: "您好，看到贵司在招前端开发工程师，我有 React/TypeScript 的中大型项目经验，想了解一下团队的技术栈。",
				timeline: [["09:40", "抓取岗位", 0], ["09:41", "agent 定制简历", 0], ["09:48", "发送失败：登录态已失效", 1]],
			},
			{
				id: "j3", company: "云启数据", title: "数据平台工程师", salary: "30-50K", city: "北京 · 5-10年",
				status: "replied", resume: "数据平台_云启_v1.pdf", hr: "赵女士", at: 12,
				jd: "岗位职责：\n1. 负责数据平台的建设与维护；\n2. 支撑业务方的数据需求。\n\n任职要求：\n1. 熟悉 Flink / Spark；\n2. 有数据仓库建模经验。",
				greeting: "您好，我对贵司的数据平台工程师岗位很感兴趣，想了解下团队目前的技术栈。",
				timeline: [["昨天 15:20", "抓取岗位", 0], ["昨天 15:22", "发送简历与打招呼语", 0], ["11:30", "招聘者回复了你", 1]],
				reply: "你好，方便发一份详细简历吗？另外想问下你目前的到岗时间。",
			},
			{
				id: "j4", company: "恒美医疗", title: "全栈工程师", salary: "22-38K", city: "北京 · 3-5年",
				status: "preparing", resume: "全栈_通用_v1.pdf", hr: "陈先生", at: 20,
				jd: "岗位职责：\n1. 独立负责业务模块的前后端开发；\n\n任职要求：\n1. 熟悉 Node.js 与前端框架；\n2. 有医疗行业经验者优先。",
				greeting: "", timeline: [["10:11", "抓取岗位", 0], ["10:12", "agent 正在定制简历", 0]],
			},
			{
				id: "j5", company: "启明智能", title: "后端开发（Go）", salary: "28-45K", city: "深圳 · 3-5年",
				status: "sent", resume: "Go后端_启明_v2.pdf", hr: "刘女士", at: 30,
				jd: "岗位职责：\n1. 负责后端服务的设计与开发。\n\n任职要求：\n1. 熟悉 Go 语言；\n2. 了解云原生。",
				greeting: "您好，看到贵司在招 Go 后端，我有云原生相关经验，期待交流。",
				timeline: [["昨天 18:02", "抓取岗位", 0], ["昨天 18:05", "发送简历与打招呼语", 0], ["昨天 18:05", "等待对方回复", 0]],
			},
			{
				id: "j6", company: "博远咨询", title: "技术顾问", salary: "面议", city: "北京 · 5-10年",
				status: "new", resume: "", hr: "", at: 42,
				jd: "岗位职责：\n1. 为客户提供技术方案咨询。\n\n任职要求：\n1. 沟通能力强；\n2. 有交付经验。",
				greeting: "", timeline: [["10:31", "抓取岗位", 0]],
			},
			{
				id: "j7", company: "星野文化", title: "小程序开发", salary: "15-25K", city: "北京 · 1-3年",
				status: "skipped", resume: "", hr: "", at: 50,
				jd: "岗位职责：\n1. 负责小程序开发。\n\n任职要求：\n1. 熟悉小程序生态。",
				greeting: "", timeline: [["昨天 20:10", "抓取岗位", 0], ["昨天 20:12", "已跳过：与方向不符", 0]],
			},
		];

		/**
		 * 岗位的「地点 + 距离」。真实值由 boss/scrape.mjs 写进 data/jobs.json，
		 * 这里先把 UI 跑通。MOCK 里原来的 `city` 其实是"城市 · 经验"的展示串，
		 * 所以顺手拆成 city / experience，并补上商圈与距离。
		 *
		 * 距离的三种真实状态都要能表达：
		 *   同城有坐标 → 3.2km；同城没坐标 → 距离未知；异地 → 异地（Boss 本身也只在同城算距离）。
		 */
		const MOCK_GEO = {
			j1: { city: "北京", area: "海淀区 · 中关村", distanceKm: 3.2 },
			j2: { city: "杭州", area: "西湖区 · 文三路", distanceKm: null },
			j3: { city: "北京", area: "海淀区 · 上地", distanceKm: null },
			j4: { city: "北京", area: "朝阳区 · 望京", distanceKm: 6.4 },
			j5: { city: "深圳", area: "南山区 · 科技园", distanceKm: null },
			j6: { city: "北京", area: "东城区 · 国贸", distanceKm: null },
			j7: { city: "北京", area: "海淀区 · 西二旗", distanceKm: 8.1 },
		};
		/** 我的城市（= data/profile.json 的 homeCity）。距离只有同城才有意义。 */
		const HOME_CITY = "北京";
		for (const a of MOCK) {
			const [cityPart, ...rest] = String(a.city ?? "").split(" · ");
			const g = MOCK_GEO[a.id] ?? {};
			a.cityLine = a.city;
			a.city = g.city ?? cityPart;
			a.area = g.area ?? "";
			a.distanceKm = g.distanceKm ?? null;
			a.experience = rest.join(" · ");
			a.sameCity = a.city === HOME_CITY;
			a.demo = true;
		}

		/**
		 * 把宿主 `/boss/state` 里的**真岗位**翻译成队列里的一行。
		 *
		 * 字段名对齐 `boss/lib.mjs` 的 normalizeJob —— 那边是抓取层的规范，
		 * 这边是 UI 的规范，只差一个 `status`：抓回来的岗位一律是 `new`，
		 * 后面每点一次「派 agent 定制」「发送」都会在本地状态机上往前走。
		 *
		 * `prev` 是上一轮的队列：同一个岗位再次被抓到时，**保留它已经走到的状态**，
		 * 只刷新 JD 侧的事实（薪资可能改了、JD 可能改了）。不然刷新一次列表，
		 * 你之前点的所有进度就没了。
		 */
		function jobsToApps(jobs, homeCity, prev) {
			const byId = new Map((prev ?? []).map((a) => [a.id, a]));
			return (jobs ?? []).map((j, i) => {
				const old = byId.get(j.id);
				const city = j.city || "";
				return {
					id: j.id,
					company: j.company || "（未写公司名）",
					title: j.title || "（未写职位名）",
					salary: j.salary || "面议",
					city,
					area: j.area || "",
					distanceKm: j.distanceKm === undefined ? null : j.distanceKm,
					sameCity: city === homeCity,
					hr: j.hr || "",
					industry: j.industry || "",
					// 展示用：经验和学历拼一行
					experience: [j.experience, j.degree].filter(Boolean).join(" · "),
					// 筛选用：各自留一份原值。七个下拉框要按字段比对，
					// 拿拼好的展示串去比会永远筛不出东西。
					experienceName: j.experience || "",
					degreeName: j.degree || "",
					jobType: j.jobType || "",
					scale: j.scale || "",
					stage: j.stage || "",
					jd: j.jd || "",
					url: j.url || "",
					securityId: j.securityId || "",
					encryptJobId: j.encryptJobId || "",
					lid: j.lid || "",
					scrapedAt: j.scrapedAt ?? null,
					detailFetchedAt: j.detailFetchedAt ?? null,
					// 状态机那一半：有旧的就接着走，没有就从"待处理"起
					status: old?.status ?? "new",
					resume: old?.resume ?? "",
					greeting: old?.greeting ?? "",
					at: old?.at ?? i,
					timeline: old?.timeline ?? [[stamp(), "抓取岗位", 0]],
					real: true,
				};
			});
		}
		//#endregion

		//#region 原子组件
		/** 状态胶囊。传了 onClick 它就是一个可点的入口（点=只看这个状态并跳到它的动作）。 */
		function Chip({ status, onClick }) {
			const meta = STATUS[status];
			const cls = "bw_chip " + meta.chip + (onClick ? " bw_chipBtn" : "");
			if (!onClick) return h("span", { className: cls }, meta.label);
			return h(
				"button",
				{
					type: "button",
					className: cls,
					title: "只看「" + meta.label + "」，并跳到这个状态要做的事",
					onClick,
				},
				meta.label,
			);
		}

		/** 队列里的一个 JD 卡片。点卡片=选中；点状态标签=按该状态筛选 + 跳到该状态的动作。 */
		function JobCard({ app, on, onPick, onPickStatus, nearKm }) {
			const pick = () => onPick(app.id);
			return h(
				"div",
				{
					className: on ? "bw_card bw_cardOn" : "bw_card",
					role: "button",
					tabIndex: 0,
					onClick: pick,
					onKeyDown: (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							pick();
						}
					},
				},
				h(
					"div",
					{ className: "bw_cardTop" },
					h("span", { className: "bw_co" }, app.company),
					h("span", { className: "bw_sal" }, app.salary),
				),
				h("div", { className: "bw_role" }, app.title),
				h(
					"div",
					{ className: "bw_meta" },
					h(Chip, {
						status: app.status,
						onClick: (e) => {
							e.stopPropagation();
							onPickStatus(app.id, app.status);
						},
					}),
					app.resume ? h("span", { className: "bw_chip" }, app.resume.length > 16 ? app.resume.slice(0, 15) + "…" : app.resume) : null,
				),
				// 地点 + 距你多远：Boss 只在同城算距离，异地在卡片上标出来比留空更有用
				h(
					"div",
					{ className: "bw_cardLoc" },
					h("span", { className: "bw_locText" }, app.city + (app.area ? " · " + app.area : "")),
					h("span", { className: distanceClass(app, nearKm) }, distanceLabel(app)),
				),
			);
		}

		/** 时间线上的一条事件。 */
		function TimelineItem({ at, text, hot }) {
			return h(
				"div",
				{ className: hot ? "bw_tlItem bw_tlHot" : "bw_tlItem" },
				h("div", { className: "bw_tlTime" }, at),
				h("div", { className: "bw_tlText" }, text),
			);
		}

		/** 一栏的标题条。 */
		function ColHead({ children }) {
			return h("div", { className: "bw_colHead" }, children);
		}

		/** 空态。可带一个动作，避免筛选之后走进死胡同。 */
		function Empty({ children, act }) {
			return h("div", { className: "bw_empty" }, children, act ? h("div", { className: "bw_emptyAct" }, act) : null);
		}
		//#endregion

		//#region 第 ① 栏：JD 队列
		function QueueColumn({ apps, selectedId, onPick, onPickStatus, filter, onClearFilter, city, kw, maxKm, jobFilters, onClearQuery, onScrape, scraping, hasReal, canScrape, coldActive }) {
			const visible = apps.filter((a) => jobMatches(a, { filter, city, kw, maxKm, jobFilters }));
			const groups = GROUPS.map((g) => ({ g, items: visible.filter(g.match).sort(byUrgency) })).filter((x) => x.items.length > 0);
			const tag = labelFilter(filter);
			// 抓取条件也做成可清除的标签，否则"筛空了"会让人以为是没抓到岗位
			const queryTag = [city, maxKm === null ? null : "≤" + String(maxKm) + "km", kw.trim() === "" ? null : "“" + kw.trim() + "”"]
				.filter((x) => x !== null && x !== undefined)
				.join(" · ");
			const clearAll = () => {
				onClearFilter();
				onClearQuery();
			};
			return h(
				"div",
				{ className: "bw_col" },
				h(
					ColHead,
					null,
					h("span", null, "JD 队列"),
					tag
						? h(
								"span",
								{ className: "bw_tag" },
								"只看 " + tag,
								h("button", { type: "button", className: "bw_tagX", title: "清除筛选", onClick: onClearFilter }, "\u00d7"),
							)
						: null,
					queryTag === ""
						? null
						: h(
								"span",
								{ className: "bw_tag" },
								queryTag,
								h("button", { type: "button", className: "bw_tagX", title: "清除抓取条件", onClick: onClearQuery }, "\u00d7"),
							),
					h("span", { className: "bw_spacer" }),
					// 数据来源要一眼看得见：演示数据 / data/jobs.json 是两回事
					hasReal === true ? null : h("span", { className: "bw_demoTag", title: "还没有抓到真岗位，下面是演示数据" }, "演示数据"),
					h("span", { style: { fontWeight: 400, letterSpacing: 0 } }, String(visible.length)),
				),
				h(
					"div",
					{ className: "bw_scroll" },
					groups.length === 0
						? h(
								Empty,
								{
									// 空态必须给下一步：要么把筛掉的条件撤掉，要么真去 Boss 搜一次。
									// 以前这里就是一个死按钮 —— "输入了没反应"很大一部分是它。
									act: h(
										"div",
										{ className: "bw_emptyActs" },
										tag !== null || queryTag !== ""
											? h("button", { type: "button", className: "bw_btn", onClick: clearAll }, "清除全部条件")
											: null,
										h(
											"button",
											{
												type: "button",
												className: "bw_btn bw_btnGo",
												disabled: canScrape !== true,
												onClick: () => onScrape(),
											},
											scraping === true ? "抓取中…" : coldActive === true ? "冷却中…" : kw.trim() === "" ? "抓推荐岗位" : "去 Boss 搜「" + kw.trim() + "」",
										),
									),
								},
								tag === null && queryTag === ""
									? "本机库里还没有岗位，先去 Boss 抓一批"
									: "本机库里没有同时满足 " + [tag, queryTag].filter(Boolean).join(" + ") + " 的岗位",
							)
						: groups.map(({ g, items }) =>
								h(
									"div",
									{ className: "bw_group", key: g.key },
									h(
										"div",
										{ className: g.hot ? "bw_groupHead bw_groupHot" : "bw_groupHead" },
										g.hot ? h("span", { className: "bw_dot" }) : null,
										h("span", null, g.title),
										h("span", { className: "bw_groupN" }, String(items.length)),
									),
									items.map((a) => h(JobCard, { key: a.id, app: a, on: a.id === selectedId, onPick, onPickStatus, nearKm: maxKm ?? 5 })),
								),
							),
				),
			);
		}
		//#endregion

		//#region 第 ② 栏：当前 JD 详情
		/**
		 * 当前 JD。三种「阻塞在你这里」的状态在这里各自收口：
		 * 底部常驻一条说明带 + 一个主行动 —— 状态要你做什么永远在视野里，
		 * 不用滚到底才找得到；点下去真的推进状态机。
		 */
		function DetailColumn({ app, focusAction, onAct, resumeName, onFetchDetail, detailLoading, assistant, onConversation, remote, replyText, onReplyText, onSendReply, greetText, onGreetText, onGenerateGreeting, onSendGreeting }) {
			if (!app) return h("div", { className: "bw_col bw_colMid" }, h(ColHead, null, "当前 JD"), h(Empty, null, "从左边选一个岗位"));
			const note = STATE_NOTE[app.status];
			const primary = PRIMARY[app.status];
			const assist = assistant?.jobId === app.id ? assistant : null;
			// 发送/打招呼的状态挂在 remote 上，由 WorkbenchPage 传进来
			// （这一层刻意不新增 useState，避免打乱 smoke.mjs 依赖的 hook 序号）。
			const sending = remote?.assistant?.jobId === app.id && remote?.assistant?.sending === true;
			const greet = remote?.greet?.jobId === app.id ? remote.greet : null;
			/**
			 * 演示数据不能操作。
			 *
			 * 这是"啥也点不了"的真正来源：`data/jobs.json` 是空的（一次都没抓成功），
			 * 左栏那 7 条是硬编码的演示岗位。它们的 id 不在岗位库里，于是
			 * 「获取完整 JD」「读取会话」「按 JD 微调」「发送」全部走不通 ——
			 * 宿主每条都回 404/409，界面上看起来就是"点了没用"。
			 * 与其让每个按钮都失败一次，不如直接说清楚：先抓到真岗位再来。
			 */
			const demo = app.real !== true;
			return h(
				"div",
				{ className: "bw_col bw_colMid" },
				h(ColHead, null, h("span", null, "当前 JD"), h("span", { className: "bw_spacer" }), h(Chip, { status: app.status })),
				h(
					"div",
					{ className: "bw_scroll" },
					h(
						"div",
						{ className: "bw_detail" },
						h("div", { className: "bw_dTitle" }, app.company + " · " + app.title),
						h(
							"div",
							{ className: "bw_dSub" },
							[app.salary, app.city + (app.experience ? " · " + app.experience : ""), app.area, distanceLabel(app), app.hr ? "HR " + app.hr : null]
								.filter((x) => x !== null && x !== undefined && x !== "")
								.join("　·　"),
						),
						// 演示岗位：一句话说清"为什么点了没用"，而不是让每个按钮失败一次
						// （类名刻意不用 bw_note：那会让"底栏常驻说明带"的位置断言认错元素）
						demo
							? h(
									"div",
									{ className: "bw_dSub bw_noteDanger" },
									"这是演示数据（data/jobs.json 里还有 0 条真岗位），不能获取 JD、不能读会话、不能发送。" +
										"先点右上角「抓取岗位」从 Boss 抓一批真的回来 —— 抓不到通常是本机 Chrome 没开 9222 调试口。",
								)
							: null,
						h(
							"div",
							{ className: "bw_sect" },
							h(
								"div",
								{ className: "bw_sectHead" },
								h("span", null, "JD 全文"),
								h("span", { className: "bw_spacer" }),
								app.real && !app.jd
									? h("button", { type: "button", className: "bw_btn", disabled: detailLoading, onClick: () => onFetchDetail?.(app.id) }, detailLoading ? "获取中…" : "获取完整 JD")
									: null,
							),
							h("div", { className: "bw_jd" }, app.jd || (app.real ? "列表接口没有返回 JD。为保护账号，不会批量补全；请点上方按钮只取这一条。" : "")),
						),
						h(
							"div",
							{ className: "bw_sect" },
							h(
								"div",
								{ className: "bw_sectHead" },
								h("span", null, "简历"),
								h("span", { className: "bw_spacer" }),
								h("span", { className: "bw_chip" }, "每个 JD 各选一份"),
							),
							h(
								"div",
								{ className: "bw_pick" },
								h("span", { className: "bw_pickFile" }, h("span", null, "📄"), h("span", { className: "bw_pickName" }, resumeName ?? app.resume ?? "尚未选择")),
								h("span", { className: "bw_pickNote" }, (resumeName ?? app.resume) ? "已就绪" : "待选"),
								h("button", { type: "button", className: "bw_btn", onClick: () => onAct(app.id, "swapResume") }, "换"),
								h("button", { type: "button", className: "bw_btn", disabled: demo || !app.jd || assist?.running === true, onClick: () => onAct(app.id, "regenerate") }, assist?.running && assist?.action === "tailor" ? "微调中…" : "按 JD 微调"),
							),
						),
						assist?.tailored
							? h(
									"div",
									{ className: "bw_sect" },
									h("div", { className: "bw_sectHead" }, h("span", null, "简历润色结果"), h("span", { className: "bw_spacer" }), h("span", { className: "bw_chip" }, "不改原文件")),
									h("div", { className: "bw_jd" }, assist.tailored.resume?.summary ?? ""),
									h("div", { className: "bw_dSub" }, "技能顺序：" + String((assist.tailored.resume?.skills ?? []).join(" · "))),
									// 逐段 before → after：只说"已优化"没法核对，得看见改了哪几句。
									...(assist.tailored.polishedSections ?? [])
										.filter((section) => section.original !== section.polished)
										.map((section, i) =>
											h(
												"div",
												{ key: "polish" + String(i) },
												h("div", { className: "bw_dSub" }, "【" + section.section + "】" + (section.changes ?? []).join("；")),
												h("div", { className: "bw_jd" }, "原：" + (section.original || "（空）") + "\n改：" + (section.polished || "（空）")),
											),
										),
									...(assist.tailored.changes ?? []).map((text, i) => h("div", { className: "bw_dSub", key: "change" + String(i) }, "• " + text)),
									...(assist.tailored.keywordAdditions?.length ? [h("div", { className: "bw_pick", key: "kwAdd" }, h("span", { className: "bw_pickNote" }, "命中的 JD 关键词"), h("span", { className: "bw_pickName" }, (assist.tailored.keywordAdditions ?? []).join("、")))] : []),
									...(assist.tailored.generalSuggestions ?? []).map((text, i) => h("div", { className: "bw_dSub", key: "sugg" + String(i) }, "→ " + text)),
									...(assist.tailored.warnings ?? []).map((text, i) => h("div", { className: "bw_note bw_noteDanger", key: "warn" + String(i) }, text)),
								)
							: null,
						h(
							"div",
							{ className: "bw_sect" },
							h(
								"div",
								{ className: "bw_sectHead" },
								h("span", null, "当前岗位会话与回复"),
								h("span", { className: "bw_spacer" }),
								h("button", { type: "button", className: "bw_btn", disabled: demo || assist?.running === true, onClick: () => onConversation?.(app.id) }, assist?.running && assist?.action === "conversation" ? "读取中…" : "读取会话并生成句子"),
								assist?.conversation
									? h("button", { type: "button", className: "bw_btn", disabled: demo || assist?.running === true, onClick: () => onConversation?.(app.id), title: "重新读一次会话（拿到 HR 的最新回复）并按新内容重写句子" }, "刷新并换一句")
									: null,
							),
							assist?.conversation?.messages?.length
								? h("div", { className: "bw_jd" }, assist.conversation.messages.slice(-8).map((message) => `${message.direction === "incoming" ? "HR" : "我"}：${message.text}`).join("\n"))
								: h("div", { className: "bw_dSub" }, demo ? "演示岗位没有会话，先抓真岗位。" : "不会自动读取；点击后才获取当前岗位会话。"),
							// 这句话是谁写的：模型 / 模板。降级必须看得见，不能让人以为模板是模型写的。
							assist?.reply
								? h(
										"div",
										{ className: "bw_pick" },
										h("span", { className: assist.reply.engine === "model" ? "bw_pickNote" : "bw_pickNote bw_noteDanger" }, assist.reply.engine === "model" ? `模型写的（${assist.reply.model ?? "deepseek"}）` : "模板句（模型没参与）"),
										h("span", { className: "bw_pickName" }, assist.reply.needsReply ? "对方在等你回" : "最新一条是你发的"),
										assist.reply.intent ? h("span", { className: "bw_dSub" }, "对方意思：" + assist.reply.intent) : null,
									)
								: null,
							assist?.reply?.engine === "rules" && assist.reply.engineError
								? h("div", { className: "bw_dSub bw_noteDanger" }, "模型没参与的原因：" + assist.reply.engineError)
								: null,
							// 每条候选句子都能一键填进下面的输入框 —— 最终发什么由你定，可以再改。
							...(assist?.reply?.drafts ?? []).map((draft, i) =>
								h(
									"div",
									{ className: "bw_pick" + (i === 0 ? " bw_pickOn" : ""), key: "reply" + String(i) },
									h("span", { className: "bw_pickNote" }, draft.style),
									h("span", { className: "bw_pickName" }, draft.text),
									h("button", { type: "button", className: "bw_btn", onClick: () => onReplyText?.(draft.text), title: "填进下面的输入框（还能改）" }, "用它"),
									h("button", { type: "button", className: "bw_btn", onClick: () => navigator.clipboard?.writeText(draft.text) }, "复制"),
								),
							),
							// 硬约束摆出来：这些是任何情况下都不该说的
							(assist?.reply?.avoid ?? []).length > 0
								? h("div", { className: "bw_dSub" }, "别忘： " + (assist.reply.avoid ?? []).join("；"))
								: null,
							// ── 真正把回复发出去 ────────────────────────────────────
							// 求职端没有发消息的 HTTP 接口，宿主走 MQTT（boss/mqtt-chat.mjs）。
							// 句子不会自动发：必须点「发送给 HR」再确认一次。
							assist?.conversation?.thread?.friendId
								? h(
										"div",
										null,
										h("textarea", {
											className: "bw_ta",
											value: replyText ?? (assist?.reply?.drafts?.[0]?.text ?? ""),
											placeholder: "要发给这位 HR 的话（点上面的「用它」或自己写）",
											onChange: (e) => onReplyText?.(e.target.value),
										}),
										h(
											"div",
											{ className: "bw_pick" },
											h("span", { className: "bw_pickNote" }, "发给 " + (assist.conversation.thread.bossName || assist.conversation.thread.company || "这位 HR")),
											h("span", { className: "bw_pickName" }, "#" + String(assist.conversation.thread.friendId)),
											h(
												"button",
												{
													type: "button",
													className: "bw_btn bw_btnPrimary",
													disabled: sending === true || !(replyText ?? "").trim() && !(assist?.reply?.drafts?.[0]?.text ?? "").trim(),
													onClick: () => onSendReply?.(app.id, assist.conversation.thread.friendId, replyText || assist?.reply?.drafts?.[0]?.text || ""),
												},
												sending === true ? "发送中…" : "发送给 HR ▸",
											),
										),
										h("div", { className: "bw_dSub" }, "只有你按这一下才会发出去。发送走 MQTT；宿主会拦掉 3 秒内的连发和 2 分钟内的同内容重发。"),
									)
								: null,
							assist?.sent ? h("div", { className: "bw_note" }, "已发送：" + assist.sent.text) : null,
							assist?.sendError ? h("div", { className: "bw_note bw_noteDanger" }, assist.sendError) : null,
							assist?.error ? h("div", { className: "bw_note bw_noteDanger" }, assist.error) : null,
						),
						h(
							"div",
							{ className: "bw_sect" },
							h(
								"div",
								{ className: "bw_sectHead" },
								h("span", null, "打招呼语"),
								h("span", { className: "bw_spacer" }),
								h("button", { type: "button", className: "bw_btn", disabled: greet?.running === true || demo, onClick: () => onGenerateGreeting?.(app.id) }, greet?.running === true ? "生成中…" : "生成话术"),
								h("button", { type: "button", className: "bw_btn bw_btnPrimary", disabled: greet?.running === true || demo || !app.securityId, onClick: () => onSendGreeting?.(app.id, greetText ?? app.greeting) }, "发送打招呼 ▸"),
							),
							// 受控 textarea：之前这里是 defaultValue 且没有 onChange，
							// 用户改的字**永远进不了请求体**，发出去的永远是服务端默认招呼语。
							h("textarea", {
								className: "bw_ta",
								value: greetText ?? app.greeting,
								placeholder: "还没有生成打招呼语（点右上角「生成话术」）",
								onChange: (e) => onGreetText?.(e.target.value),
							}),
							!app.securityId ? h("div", { className: "bw_dSub bw_noteDanger" }, "这条岗位没有 securityId，无法打招呼；重新抓一次岗位列表即可。") : null,
							greet?.error ? h("div", { className: "bw_dSub bw_noteDanger" }, greet.error) : null,
							greet?.ok === true ? h("div", { className: "bw_dSub" }, "打招呼已发出（不含附件简历 —— 插件不会替你上传简历附件）") : null,
						),
					),
				),
				h(
					"div",
					{ className: "bw_foot" },
					h("div", { className: "bw_note " + (note[0] ? "bw_note" + note[0] : "") }, note[1]),
					h(
						"div",
						{ className: focusAction ? "bw_actions bw_actionsFocus" : "bw_actions", key: focusAction },
						h("button", { type: "button", className: "bw_btn", onClick: () => onAct(app.id, "regenerate") }, "重新生成"),
						h("span", { className: "bw_spacer" }),
						h("button", { type: "button", className: "bw_btn", onClick: () => onAct(app.id, "skip") }, "跳过"),
						primary
							? h(
									"button",
									{
										type: "button",
										className: primary.run === "retry" ? "bw_btn bw_btnDanger" : "bw_btn bw_btnPrimary",
										onClick: () => onAct(app.id, primary.run),
									},
									primary.label,
								)
							: null,
					),
				),
			);
		}
		//#endregion

		//#region 余额（账号还剩多少钱）
		const CURRENCY_SYMBOL = { CNY: "¥", USD: "$" };
		const formatBalance = (amount, currency) =>
			amount === null || amount === undefined ? "—" : (CURRENCY_SYMBOL[currency] ?? currency + " ") + amount.toFixed(2);

		/**
		 * 余额状态 → 显示用的三个东西。
		 * 三种状态都要能看：还没查到（…）、查不到（—，鼠标悬停给原因）、查到了。
		 */
		function balanceView(b) {
			if (b === null) return { text: "余额 …", wait: true, low: false, title: "正在查询账号余额" };
			if (b.ok !== true) return { text: "余额 —", wait: true, low: false, title: b.error ?? "查不到余额" };
			const low = typeof b.total === "number" && b.total <= 10;
			return {
				text: "余额 " + formatBalance(b.total, b.currency),
				wait: false,
				low,
				title: `${b.currency} 总额 ${b.total}　赠送 ${b.granted ?? "—"}　充值 ${b.toppedUp ?? "—"}　更新于 ${b.at ?? "?"}${b.cached === true ? "（缓存）" : ""}${low ? "　⚠ 余额偏低" : ""}`,
			};
		}

		/** 包一层：谁来渲染都走这里取数据。 */
		function useBalance() {
			const [b, setB] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				const load = () =>
					fetch("/boss/balance", { credentials: "same-origin" })
						.then((r) => {
							if (r.ok) return r.json();
							// 失败也要落到"查不到"，否则永远卡在"…"，看不出是坏在哪
							if (r.status === 404) return { ok: false, error: "宿主 /boss 路由还没起来 —— 重启一次 DSH GUI 后生效" };
							return { ok: false, error: "HTTP " + String(r.status) };
						})
						.then((j) => {
							if (alive && j !== null) setB(j);
						})
						.catch((err) => {
							if (alive) setB({ ok: false, error: "请求失败：" + String(err?.message ?? err) });
						});
				load();
				const id = setInterval(load, 60000); // 一分钟一次，"实时"够用且不打爆接口
				return () => {
					alive = false;
					clearInterval(id);
				};
			}, []);
			return b;
		}

		/** 会话区右下角那一颗。它自己拉数据 —— composer.dock 的注册不给 owner props。 */
		function BalancePill() {
			const b = useBalance();
			const v = balanceView(b);
			return h(
				"div",
				{ className: "bw_balDock" },
				h(
					"span",
					{ className: "bw_balPill" + (v.wait ? " bw_balWait" : v.low ? " bw_balLow" : ""), title: v.title },
					v.text,
				),
			);
		}
		/** 工作台表头那一颗。独立成组件，这样 WorkbenchPage 自己不用多一个 state。 */
		function WorkbenchBalance() {
			const b = useBalance();
			const v = balanceView(b);
			return h("span", { className: "bw_bal" + (v.wait ? " bw_balWait" : v.low ? " bw_balLow" : ""), title: v.title }, v.text);
		}
		//#endregion

		//#region 登录闸门（进工作台时没登录就先弹二维码）
		const PHASE_TEXT = {
			idle: ["正在连接 Chrome…", "wait"],
			"connecting-browser": ["正在连接 Chrome…", "wait"],
			"waiting-browser": ["请在 Chrome 的 Boss 标签中登录", "hot"],
			verifying: ["正在用当前页面校验登录态…", "wait"],
			"logged-in": ["登录成功", "ok"],
			"browser-unavailable": ["没有找到可复用的 Chrome 会话", "bad"],
			"ip-risk": ["当前 IP 被风控（code 35）", "bad"],
			"account-risk": ["账号触发风控（code 36）", "bad"],
			"environment-risk": ["浏览器环境触发风控（code 37）", "bad"],
			"browser-blocked": ["Boss 拦截了当前页面", "bad"],
			"rate-limited": ["请求过快，已停止", "bad"],
			expired: ["等待登录超时", "bad"],
			failed: ["登录失败", "bad"],
		};

		/**
		 * 工作台的登录闸门。
		 * 流程完全走宿主路由：先连接用户现有 Chrome，再观察其中的 Boss cookie；
		 * 登录完成后只做一次同页校验，不再由 Node 申请二维码或启动无头浏览器。
		 *
		 * 独立成组件（而不是塞进 WorkbenchPage），这样 WorkbenchPage 的 hook 序号不变，
		 * 测试里那些按序号驱动的用例不会被我改坏。
		 */
		function LoginGate({ onLoggedIn, onUnavailable, reloadKey }) {
			const [gate, setGate] = react.useState({ open: false, qr: null, phase: "idle", error: null, detail: null });
			const [dismissed, setDismissed] = react.useState(false);

			/** 只有这几种 phase 是"用户真的能去登录"；其余都是在解释故障。 */
			const canLogIn = (phase) => phase === "waiting-browser" || phase === "connecting-browser" || phase === "idle" || phase === "verifying";

			// 挂载时问一次登录态。
			//
			// ⚠️ 闸门**只在真的能登录时**才顶上来（见 canLogIn）。
			// 之前的写法是"只要不是 loggedIn 就弹"—— 于是 Chrome 根本没开调试口的时候，
			// 用户看到的是一句"请在真实 Chrome 标签中完成扫码"加一个空二维码位，
			// 看起来像插件在等他扫码，实际上是连都连不上。那种情况下应该解释原因，
			// 而不是催他扫一个不存在的码。
			//
			// reloadKey 变化（= 刚点了退出登录）也会重跑一遍，所以"退出"之后闸门会自己弹回来。
			react.useEffect(() => {
				let alive = true;
				(async () => {
					try {
						const st = await fetch("/boss/login/state", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
						if (!alive || st === null) return;
						if (st.loggedIn === true) {
							onUnavailable?.(null);
							return;
						}
						const started = await fetch("/boss/login/start", { method: "POST", credentials: "same-origin" }).then((r) => r.json());
						if (!alive) return;
						// 宿主说"登录成功"，但这个闸门**正是因为 state 说没登录才打开的**。
						// 两个判据打架时以 state 为准：再问一次，不一致就强制重发二维码。
						// （以前这里直接把 phase=logged-in 画出来，于是界面上写着"登录成功"
						//   旁边却是个空二维码位，而实际登录态是失效的 —— 用户看到的"每次点都弹码"。）
						if (started.phase === "logged-in") {
							const again = await fetch("/boss/login/state?force=1", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null));
							if (!alive) return;
							if (again?.loggedIn !== true) {
								const fresh = await fetch("/boss/login/start?force=1", { method: "POST", credentials: "same-origin" }).then((r) => r.json());
								if (!alive) return;
								if (canLogIn(fresh.phase)) setGate({ open: true, qr: fresh.qr ?? null, phase: fresh.phase ?? "failed", error: fresh.error ?? null, detail: fresh.detail ?? null });
								else reportUnavailable(fresh, st);
								return;
							}
						}
						if (canLogIn(started.phase)) {
							setGate({ open: true, qr: started.qr ?? null, phase: started.phase ?? "failed", error: started.error ?? null, detail: started.detail ?? null });
						} else {
							// 连不上 Chrome / 撞风控：不催扫码，改成工作台里一条可读的说明带
							reportUnavailable(started, st);
						}
					} catch (err) {
						if (alive) onUnavailable?.({ reason: String(err?.message ?? err), code: "GATE_ERROR", at: Date.now() });
					}
				})();
				return () => {
					alive = false;
				};
			}, [reloadKey]);

			// 开着的时候每 2 秒推进一步
			react.useEffect(() => {
				if (!gate.open) return;
				if (gate.phase === "logged-in" || ["browser-unavailable", "ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited", "expired", "failed"].includes(gate.phase)) return;
				const id = setInterval(async () => {
					try {
						const s = await fetch("/boss/login/status", { credentials: "same-origin" }).then((r) => r.json());
						// detail 是宿主那边的细粒度进度（"等 __zp_stoken__… 已 3s"）。
						// 安全验证要开一次浏览器，没有它用户只能看着转圈猜是不是卡死了。
						setGate((cur) => ({ ...cur, phase: s.phase ?? cur.phase, error: s.error ?? null, detail: s.detail ?? null }));
						if (s.phase === "logged-in") onLoggedIn();
						// 连上了/登录了就把"连不上"那条说明带撤掉
						if (s.phase === "logged-in" || s.phase === "waiting-browser" || s.phase === "verifying") onUnavailable?.(null);
					} catch { /* 下一轮再试 */ }
				}, 2000);
				return () => clearInterval(id);
				// onLoggedIn 故意不入依赖：它每次渲染都是新函数，入依赖会让 2 秒的计时器一直被重建
			}, [gate.open, gate.phase]);

			if (!gate.open || dismissed) return null;
			const [text, tone] = PHASE_TEXT[gate.phase] ?? [gate.phase, ""];
			const spinning = tone === "wait";
			const dead = ["browser-unavailable", "ip-risk", "account-risk", "environment-risk", "browser-blocked", "rate-limited", "expired", "failed"].includes(gate.phase);
			return h(
				"div",
				{ className: "bw_gate" },
				h(
					"div",
					{ className: "bw_gateCard" },
					h("div", { className: "bw_gateTitle" }, gate.phase === "logged-in" ? "已绑定 Boss 浏览器会话" : "连接真实 Chrome 登录 Boss"),
					h("div", { className: "bw_gateSub" }, gate.phase === "logged-in" ? "搜索、JD 和监听都会复用这个页面，不会另开无头浏览器。" : "先用 --remote-debugging-port=9222 启动 Chrome，再在该 Chrome 中打开并登录 Boss。插件不会伪造机器指纹。"),					h(
						"div",
						{ className: "bw_gateQr" },
						gate.qr === null
							? h("span", { className: "bw_gateSub" }, dead ? "连接未建立" : "请在真实 Chrome 标签中完成扫码或手机确认")
							: h("img", { className: "bw_gateQrImg", src: gate.qr, alt: "Boss 登录二维码" }),
					),
					h("div", { className: "bw_gatePhase bw_gate" + (tone === "" ? "" : tone.charAt(0).toUpperCase() + tone.slice(1)) }, spinning ? h("span", { className: "bw_spin" }) : null, text),
					// 细粒度进度：安全验证那一步要开浏览器、要等 stoken，只转圈会让人以为卡死了
					gate.detail !== null && gate.detail !== undefined && gate.detail !== "" && !dead
						? h("div", { className: "bw_gateDetail" }, gate.detail)
						: null,
					gate.error !== null ? h("div", { className: "bw_gatePhase bw_gateBad" }, gate.error) : null,
					h(
						"div",
						{ className: "bw_gateActs" },
						dead
							? h(
									"button",
									{
										type: "button",
										className: "bw_btn bw_btnPrimary",
										onClick: async () => {
											setGate((cur) => ({ ...cur, phase: "idle", error: null }));
											const again = await fetch("/boss/login/start?force=1", { method: "POST", credentials: "same-origin" }).then((r) => r.json()).catch(() => null);
											setGate({ open: true, qr: again?.qr ?? null, phase: again?.phase ?? "failed", error: again?.error ?? "取二维码失败", detail: again?.detail ?? null });
										},
									},
									"重新连接 Chrome",
								)
							: null,
						gate.phase === "logged-in"
							? h("button", { type: "button", className: "bw_btn bw_btnPrimary", onClick: () => setDismissed(true) }, "开始用")
							: h("button", { type: "button", className: "bw_btn", onClick: () => setDismissed(true) }, "稍后再说"),
					),
				),
			);
		}
		//#endregion

		//#region 简历库（全局 · 右栏下半）
		const PHASE_LABEL = { queued: "排队中", uploading: "上传中", parsing: "解析中", done: "已就绪", failed: "失败" };
		/** 结构化卡片里的一行键值。 */
		const kvPair = (k, v, i) =>
			h("div", { className: "bw_kv2", key: k + String(i) }, h("span", { className: "bw_kv2K" }, k), h("span", { className: "bw_kv2V" }, v === "" || v === null || v === undefined ? "—" : v));

		/** 一份正在上传/解析的简历：进度条。上传是真进度（XHR 字节），解析是同步的，只能显示"进行中"。 */
		function UploadRow({ u }) {
			const pct = u.phase === "queued" ? 8 : u.phase === "uploading" ? Math.max(8, u.pct) : 100;
			const fill = "bw_barFill" + (u.phase === "done" ? " bw_barDone" : u.phase === "failed" ? " bw_barBad" : "");
			return h(
				"div",
				{ className: "bw_upRow" },
				h(
					"div",
					{ className: "bw_upTop" },
					h("span", { className: "bw_upName" }, u.name),
					h("span", { className: "bw_upPct" }, u.phase === "uploading" ? PHASE_LABEL.uploading + " " + String(u.pct) + "%" : PHASE_LABEL[u.phase] ?? u.phase),
				),
				h("div", { className: "bw_bar" }, h("div", { className: fill, style: { width: pct + "%" } })),
				u.error ? h("div", { className: "bw_upPct" }, u.error) : null,
			);
		}

		/** 一份已入库的简历：折叠起来只看名字和状态，展开看结构化字段。 */
		function ResumeCard({ f, open, selected, onToggle, onSelect, onDelete }) {
			const s = f.structured ?? null;
			const parsed = f.status === "parsed";
			return h(
				"div",
				{ className: selected ? "bw_rw bw_rwOn" : "bw_rw" },
				h(
					"div",
					{
						className: "bw_rwHead",
						role: "button",
						tabIndex: 0,
						onClick: onToggle,
						onKeyDown: (e) => {
							if (e.key === "Enter" || e.key === " ") {
								e.preventDefault();
								onToggle();
							}
						},
					},
					h("span", { className: "bw_rwCaret" }, open ? "▾" : "▸"),
					h("span", { className: "bw_rwName", title: f.name }, f.name),
					selected ? h("span", { className: "bw_chip bw_chipBrand" }, "当前") : null,
					h("span", { className: "bw_chip " + (parsed ? "bw_chipOk" : "bw_chipBad") }, parsed ? "已解析" : "失败"),
					// 删除挂在标题行上：不用先展开就能删
					h(
						"button",
						{
							type: "button",
							className: "bw_rwX",
							title: "删除这份简历",
							"aria-label": "删除 " + f.name,
							onClick: (e) => {
								e.stopPropagation();
								onDelete();
							},
						},
						"\u00d7",
					),
				),
				open
					? h(
							"div",
							{ className: "bw_rwBody" },
							kvPair("文件", f.ext + " · " + Math.max(1, Math.round(f.bytes / 1024)) + "KB"),
							parsed && s !== null
								? h(
										"div",
										null,
										kvPair("姓名", s.name),
										kvPair("城市", s.city),
										kvPair("学历", s.degree + ((s.degrees ?? []).length > 1 ? "（" + s.degrees.join("/") + "）" : "")),
										kvPair("年限", s.yoe === null ? "" : s.yoe + " 年 · " + s.seniority),
										kvPair("联系", [s.phone, s.email].filter((x) => x !== "" && x !== undefined).join(" · ")),
										kvPair("期望", (s.targetTitles ?? []).join(" / ")),
										h(
											"div",
											{ className: "bw_kv2" },
											h("span", { className: "bw_kv2K" }, "技能"),
											h("span", { className: "bw_kv2V" }, String((s.skills ?? []).length) + " 项"),
										),
										h("div", { className: "bw_skills" }, (s.skills ?? []).slice(0, 24).map((k) => h("span", { key: k, className: "bw_skill" }, k))),
										(s.experience ?? []).length > 0
											? h(
													"div",
													{ style: { marginTop: 6 } },
													(s.experience ?? []).slice(0, 3).map((e, i) => kvPair(e.period || "经历", e.company + (e.title ? " · " + e.title : ""), i)),
												)
											: null,
									)
								: h("div", { className: "bw_kv2" }, h("span", { className: "bw_kv2V" }, f.error ?? "没有结构化结果")),
							(f.warnings ?? []).length > 0 ? h("div", { className: "bw_kv2" }, h("span", { className: "bw_kv2V" }, "⚠ " + f.warnings.join("；"))) : null,
							f.textPath ? kvPair("全文", f.textPath) : null,
							h(
								"div",
								{ style: { display: "flex", gap: 6, marginTop: 8 } },
								h(
									"button",
									{ type: "button", className: parsed ? (selected ? "bw_btn" : "bw_btn bw_btnPrimary") : "bw_btn", disabled: !parsed, onClick: onSelect },
									selected ? "已选为当前简历" : "设为当前简历",
								),
								h("button", { type: "button", className: "bw_btn", onClick: onDelete }, "删除"),
							),
						)
					: null,
			);
		}

		/**
		 * 简历库面板。三件事：上传（拖拽/点选，可多份）→ 进度 → 结构化卡片。
		 * 它是**全局**的，所以放在右栏但不在"当前 JD"的条件里（设计上就永远在）。
		 */
		function ResumeLibrary({ state, uploads, onFiles, onDelete, onRescan, selectedResume, onSelect, collapsed, onToggle }) {
			const [open, setOpen] = react.useState({});
			const [dropHot, setDropHot] = react.useState(false);
			const inputRef = react.useRef(null);
			const files = state?.resumes?.files ?? [];
			const okCount = files.filter((f) => f.status === "parsed").length;
			return h(
				"div",
				{ className: collapsed ? "bw_col bw_colLib bw_colLibOff" : "bw_col bw_colLib" },
				h(
					"div",
					{ className: "bw_libBar" },
					h("span", { className: "bw_libTitle" }, "简历库"),
					h("span", { className: "bw_libN" }, String(okCount) + "/" + String(files.length)),
					h("span", { className: "bw_spacer" }),
					h("button", { type: "button", className: "bw_btn", onClick: onRescan, title: "重新扫描 resumes/ 目录" }, "重扫"),
					h("button", { type: "button", className: "bw_btn bw_btnPrimary", onClick: () => inputRef.current?.click?.() }, "上传"),
					h("button", { type: "button", className: "bw_btn", onClick: onToggle, title: collapsed ? "展开简历库" : "收起简历库" }, collapsed ? "▸" : "▾"),
				),
				collapsed
					? null
					: h(
							"div",
							{ className: "bw_libBody" },
							h("input", {
								ref: inputRef,
								type: "file",
								multiple: true,
								style: { display: "none" },
								accept: ".pdf,.docx,.doc,.md,.txt,.html,.json",
								onChange: (e) => {
									onFiles([...(e.target.files ?? [])]);
									e.target.value = "";
								},
							}),
							h(
								"div",
								{
									className: dropHot ? "bw_drop bw_dropHot" : "bw_drop",
									onDragOver: (e) => {
										e.preventDefault();
										setDropHot(true);
									},
									onDragLeave: () => setDropHot(false),
									onDrop: (e) => {
										e.preventDefault();
										setDropHot(false);
										onFiles([...(e.dataTransfer?.files ?? [])]);
									},
								},
								"把简历拖进来，或 ",
								h("button", { type: "button", className: "bw_dropAct", onClick: () => inputRef.current?.click?.() }, "点这里选文件"),
								h("br"),
								"PDF / Word(.docx) / Markdown，一次可以多份",
							),
							uploads.map((u, i) => h(UploadRow, { key: u.name + String(i), u })),
							// 删除 / 重扫失败的原因必须看得见，否则就是"点了没反应"
							state?.libError ? h("div", { className: "bw_libErr", role: "alert" }, state.libError) : null,
							files.length === 0 ? h(Empty, null, "还没有简历") : files.map((f) => h(ResumeCard, {
								key: f.name,
								f,
								open: open[f.name] === true,
								selected: f.name === selectedResume,
								onToggle: () => setOpen((cur) => ({ ...cur, [f.name]: !cur[f.name] })),
								onSelect: () => onSelect(f.name),
								onDelete: () => onDelete(f.name),
							})),
						),
			);
		}
		//#endregion

		//#region 第 ③ 栏：这个 JD 的进展
		/** 进展栏读为主：时间线 + 键值 + 回复。动作只有「打开会话」「去回话」。 */
		function ProgressColumn({ app, onAct }) {
			if (!app) return h("div", { className: "bw_col" }, h(ColHead, null, "进展"), h(Empty, null, "—"));
			return h(
				"div",
				{ className: "bw_col" },
				h(ColHead, null, "这个 JD 的进展"),
				h(
					"div",
					{ className: "bw_scroll" },
					h(
						"div",
						{ className: "bw_detail" },
						h(
							"div",
							{ className: "bw_sect", style: { marginTop: 0 } },
							h("div", { className: "bw_sectHead" }, h("span", null, "时间线")),
							h("div", { className: "bw_tl" }, app.timeline.map((t, i) => h(TimelineItem, { key: i, at: t[0], text: t[1], hot: t[2] === 1 }))),
						),
						h("div", { className: "bw_hr" }),
						h(
							"div",
							null,
							h(
								"div",
								{ className: "bw_kv" },
								h("span", { className: "bw_kvK" }, "状态"),
								h(Chip, { status: app.status }),
							),
							h(
								"div",
								{ className: "bw_kv" },
								h("span", { className: "bw_kvK" }, "简历"),
								h("span", { className: "bw_kvV" }, app.resume || "—"),
							),
							h(
								"div",
								{ className: "bw_kv" },
								h("span", { className: "bw_kvK" }, "会话"),
								h("span", { className: "bw_kvV" }, app.status === "review" ? "agent 等你确认" : app.status === "preparing" ? "agent 运行中" : "—"),
								h("button", { type: "button", className: "bw_btn" }, "打开会话"),
							),
						),
						app.reply
							? h(
									"div",
									{ className: "bw_sect" },
									h("div", { className: "bw_sectHead" }, h("span", null, "招聘者回复")),
									// 进展栏读为主：回复只作证据留在这里，「去回话」的入口在中栏底部常驻区
									h("div", { className: "bw_jd", style: { maxHeight: 120 } }, app.reply),
								)
							: null,
					),
				),
			);
		}
		//#endregion

		//#region 全屏工作台（注册进 'main' 的 keyed 席位）
		/**
		 * 工作台主页。挂载在 `main` 槽位的 `boss-workbench` key 上 ——
		 * 点击左侧导航图标由 sidebar 的 panellist 机制切换到这里。
		 *
		 * 阶段 0 只有内存状态：每一次点击都在这里落成真的状态迁移 + 一条时间线，
		 * 便于评审"点下去到底会发生什么"。阶段 1 把 setApps 换成宿主半边读写即可。
		 */
		function WorkbenchPage() {
			// 第一个 hook 必须留给选中项：smoke.mjs 靠它逐个 JD 驱动渲染分支
			const [selectedId, setSelectedId] = react.useState("j1");
			const [apps, setApps] = react.useState(MOCK);
			const [filter, setFilter] = react.useState(null);
			const [focusAction, setFocusAction] = react.useState(0);
			// hook 序号 4/5/6 是「抓取条件」。刻意排在 0-3 之后：smoke.mjs 按序号驱动 0/2/3
			const [city, setCity] = react.useState(null);
			const [kw, setKw] = react.useState("");
			const [maxKm, setMaxKm] = react.useState(null);
			// hook 序号 7/8/9/10 是「简历库」。同样排在后面，保住 0-6 的存档位。
			// 7 remote = GET /boss/state 的原样结果（预览时由 harness 直接喂一个进来）
			const [remote, setRemote] = react.useState(null);
			const [selectedResume, setSelectedResume] = react.useState(null);
			const [libCollapsed, setLibCollapsed] = react.useState(false);
			const [uploads, setUploads] = react.useState([]);
			// 连不上 Chrome 时的那条说明带。挂 remote 上（不新增 useState，保 hook 序号）。
			const offline = remote?.offline ?? null;
			const dismissOffline = () => setRemote((cur) => ({ ...(cur ?? {}), offline: null }));
			// 本地假定时器在 §16.5 之后已经没有了（所有动作都走真请求），
			// 但这个 ref + cleanup 留着：子组件的 effect 也可能登记进来的东西，
			// 卸载时统一清掉比"等别人想起来清"安全。
			const timers = react.useRef([]);
			react.useEffect(() => () => timers.current.forEach(clearTimeout), []);
			// 进页面就把宿主那份真数据拉过来（拿不到就安静地退回演示数据）
			const loadState = () =>
				fetch("/boss/state", { credentials: "same-origin" })
					.then((r) => (r.ok ? r.json() : null))
					.then((j) => {
						if (j?.ok === true) setRemote(j);
					})
					.catch(() => {});
			react.useEffect(() => {
				loadState();
			}, []);

			/**
			 * 真数据一到就顶掉演示数据。
			 *
			 * 之前这里是空的：`remote.jobs` 拉回来了却没人用，列表永远是那 7 条 MOCK，
			 * 于是"在输入框里打字"只能筛演示数据 —— 筛不出东西就是用户看到的"没反应"。
			 * 这个 effect 就是那句话的答案：**列表跟着 data/jobs.json 走**。
			 */
			const homeCity = remote?.profile?.homeCity ?? HOME_CITY;
			const hasReal = (remote?.jobs ?? []).length > 0;
			react.useEffect(() => {
				const real = jobsToApps(remote?.jobs ?? [], homeCity, apps);
				if (real.length > 0) setApps(real);
			}, [remote?.jobs, homeCity]);

			const selected = apps.find((a) => a.id === selectedId) ?? null;
			const hotCount = apps.filter((a) => STATUS[a.status].hot).length;
			const sentCount = apps.filter((a) => a.status === "sent").length;
			const schedule = (fn, ms) => timers.current.push(setTimeout(fn, ms));

			/**
			 * 七个 Boss 维度的筛选项。它们既参与**本地判定**（jobMatches），
			 * 也会跟着 /boss/scrape 发给服务端；所以 `query` 里必须带上它们，
			 * 否则"选了行业"只会写进 state、左边列表纹丝不动。
			 */
			const jobFilters = remote?.jobFilters ?? {};
			/** 抓取条件 + 状态筛选一起决定"队列里还剩谁"。 */
			const query = { filter, city, kw, maxKm, jobFilters };
			const shownCount = apps.filter((a) => jobMatches(a, query)).length;
			const cityOptions = [...new Set([...Object.keys(remote?.cities ?? {}), ...apps.map((a) => a.city)])].filter(Boolean).sort();
			const setJobFilter = (key, value) => {
				const next = { ...jobFilters, [key]: value || null };
				setRemote((cur) => ({ ...(cur ?? {}), jobFilters: next }));
				refocus({ ...query, jobFilters: next });
			};
			/** 返回没有任何筛选时的样子（城市/关键词/距离/七个维度一起清）。 */
			const clearQuery = () => {
				setCity(null);
				setKw("");
				setMaxKm(null);
				setRemote((cur) => ({ ...(cur ?? {}), jobFilters: {} }));
			};
			/** 条件变了以后，如果选中的 JD 被筛掉，把焦点交给第一条可见项。 */
			const refocus = (next) => {
				const visible = apps.filter((a) => jobMatches(a, next));
				if (visible.length > 0 && !visible.some((a) => a.id === selectedId)) setSelectedId(visible[0].id);
			};

			// ── 简历库：上传 / 删除 / 重扫（都打宿主的 /boss 路由）────────────────
			/**
			 * 失败**不能**吞成 null：之前 `.catch(() => null)` 让 401/404/500 和断网全变成"没反应"，
			 * 用户点了删除什么都不发生、也没有任何提示。现在一律回 `{ ok: false, error }`。
			 */
			const postJson = (path, body) =>
				fetch(path, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })
					.then(async (r) => {
						const text = await r.text();
						let json = null;
						try { json = JSON.parse(text); } catch { /* 非 JSON（401 unauthorized / 404 文本）走下面 */ }
						if (json !== null && typeof json === "object") return json;
						return { ok: false, error: "HTTP " + String(r.status) + (text ? "：" + text.slice(0, 120) : "") };
					})
					.catch((err) => ({ ok: false, error: "请求失败：" + String(err?.message ?? err) }));

			/**
			 * 传一份。用 XHR 才有真实的上传字节进度（fetch 拿不到）；
			 * 传完服务端是同步解析的，所以进度条切到"解析中"等响应。
			 */
			const uploadOne = (file) =>
				new Promise((resolve) => {
					const patch = (p) => setUploads((cur) => cur.map((u) => (u.name === file.name ? { ...u, ...p } : u)));
					const xhr = new XMLHttpRequest();
					xhr.open("POST", "/boss/resumes/upload?name=" + encodeURIComponent(file.name));
					xhr.upload.onprogress = (e) => {
						if (e.lengthComputable) patch({ pct: Math.round((e.loaded / e.total) * 100) });
					};
					xhr.upload.onload = () => patch({ phase: "parsing" });
					xhr.onerror = () => {
						patch({ phase: "failed", error: "网络错误" });
						resolve(null);
					};
					xhr.onload = () => {
						let json = null;
						try {
							json = JSON.parse(xhr.responseText);
						} catch { /* 非 JSON 就当失败 */ }
						if (xhr.status === 200 && json?.ok === true) {
							patch({ phase: "done", pct: 100 });
							resolve(json);
						} else {
							patch({ phase: "failed", error: json?.error ?? "HTTP " + String(xhr.status) });
							resolve(null);
						}
					};
					xhr.send(file);
				});

			/** 多份排队传：顺序上传，进度条才读得懂，也不会一次把请求打满。 */
			const uploadFiles = (files) => {
				if (files.length === 0) return;
				setUploads((cur) => [...cur, ...files.map((f) => ({ name: f.name, pct: 0, phase: "queued", error: null }))]);
				setLibCollapsed(false);
				(async () => {
					for (const f of files) {
						setUploads((cur) => cur.map((u) => (u.name === f.name ? { ...u, phase: "uploading" } : u)));
						const res = await uploadOne(f);
						if (res?.index !== undefined) setRemote((cur) => ({ ...(cur ?? {}), ok: true, resumes: res.index }));
					}
					schedule(() => setUploads((cur) => cur.filter((u) => u.phase !== "done")), 3000);
				})();
			};

			const rescanResumes = async () => {
				const j = await postJson("/boss/resumes/rescan");
				if (j?.ok === true) setRemote((cur) => ({ ...(cur ?? {}), ok: true, resumes: j.index, libError: null }));
				else setRemote((cur) => ({ ...(cur ?? {}), libError: "重扫失败：" + String(j?.error ?? "宿主没有返回结果") }));
			};
			const deleteResume = async (name) => {
				const j = await postJson("/boss/resumes/delete", { name });
				if (j?.ok === true) {
					// removed=false 说明磁盘上已经没有这个文件（索引过期）；索引已按目录重建，界面跟着刷新即可
					setRemote((cur) => ({ ...(cur ?? {}), ok: true, resumes: j.index, libError: null }));
					if (selectedResume === name) setSelectedResume(null);
					return;
				}
				setRemote((cur) => ({ ...(cur ?? {}), libError: "删除「" + name + "」失败：" + String(j?.error ?? "宿主没有返回结果") }));
			};

			// ── 抓岗位：输入框里的关键词，回车就真去 Boss 搜 ────────────────────
			// 进度/错误塞在 remote.scrape 里而不是另开一个 useState：
			// smoke.mjs 的 hook 序号（0-10 归本组件，11 起归子组件）不能再挪了。
			const scrape = remote?.scrape ?? null;
			const scraping = scrape?.running === true;
			/**
			 * 冷却期：宿主撞过风控就把抓取锁上，这里跟着禁用按钮。
			 * 风控按频率扣分，"再点一次"正是最该被拦下来的那个动作 ——
			 * 靠人自觉是拦不住的，所以按钮直接点不动。
			 */
			const cold = remote?.cooldown ?? null;
			const coldActive = cold !== null && cold.expired === false;
			const coldMinutes = coldActive ? Math.max(1, Math.ceil((cold.remainingMs ?? 0) / 60000)) : 0;
			const canScrape = scraping === false && coldActive === false;

			/**
			 * 一次抓取。`override` 用来让"清空条件后改抓推荐流"这类动作复用同一条路径。
			 * 有关键词走 search，没关键词走 recommend —— 后者是参考项目实测唯一稳的那条。
			 */
			const doScrape = async (override) => {
				if (!canScrape) return;
				const q = String(override?.query ?? kw).trim();
				const c = override?.city === undefined ? city : override.city;
				const km = override?.maxKm === undefined ? maxKm : override.maxKm;
				const mode = override?.mode ?? (q === "" ? "recommend" : "search");
				const startedAt = Date.now();
				setRemote((cur) => ({ ...(cur ?? {}), scrape: { running: true, mode, query: q, city: c, startedAt } }));
				const j = await postJson("/boss/scrape", { mode, city: c, query: q, maxKm: km, pages: 1, pageSize: 30, ...jobFilters });
				const ms = Date.now() - startedAt;
				if (j === null) {
					setRemote((cur) => ({ ...(cur ?? {}), scrape: { running: false, mode, query: q, city: c, ms, error: "宿主半边没响应（/boss/scrape 打不通）" } }));
					return;
				}
				setRemote((cur) => ({
					...(cur ?? {}),
					jobs: j.jobs ?? cur?.jobs ?? [],
					jobsUpdatedAt: j.jobsUpdatedAt ?? null,
					lastQuery: j.lastQuery ?? null,
					scrape: {
						running: false, mode, query: q, city: c, ms,
						ok: j.ok === true,
						fetched: j.fetched ?? 0,
						added: j.added ?? 0,
						total: j.total ?? 0,
						error: j.ok === true ? null : (j.error ?? j.stopped?.message ?? "没抓到岗位"),
						flagged: j.stopped?.kind === "flagged",
						reason: j.reason ?? null,
					},
				}));
			};

			// JD 只在用户明确点击时单条获取，绝不在列表加载后自动连打。
			const fetchDetail = async (id) => {
				if (remote?.detail?.running === true) return;
				setRemote((cur) => ({ ...(cur ?? {}), detail: { running: true, id } }));
				const j = await postJson("/boss/jobs/detail", { id });
				setRemote((cur) => ({
					...(cur ?? {}),
					jobs: j?.jobs ?? cur?.jobs ?? [],
					detail: { running: false, id, ok: j?.ok === true, error: j?.ok === true ? null : (j?.error ?? "JD 获取失败") },
				}));
			};

			const tailorResume = async (id) => {
				if (remote?.assistant?.running === true) return;
				setRemote((cur) => ({ ...(cur ?? {}), assistant: { running: true, jobId: id, action: "tailor" } }));
				const j = await postJson("/boss/assist/tailor-resume", { jobId: id, resumeName: selectedResume });
				setRemote((cur) => ({ ...(cur ?? {}), assistant: { ...(cur?.assistant ?? {}), running: false, jobId: id, tailored: j?.item ?? null, error: j?.ok === true ? null : (j?.error ?? "简历微调失败") } }));
				return j;
			};

			const loadConversationAndAdvice = async (id) => {
				if (remote?.assistant?.running === true) return;
				setRemote((cur) => ({ ...(cur ?? {}), assistant: { ...(cur?.assistant ?? {}), running: true, jobId: id, action: "conversation", error: null } }));
				const conversation = await postJson("/boss/messages/for-job", { jobId: id });
				if (conversation?.ok !== true) {
					setRemote((cur) => ({ ...(cur ?? {}), assistant: { ...(cur?.assistant ?? {}), running: false, jobId: id, conversation: null, error: conversation?.error ?? "会话获取失败" } }));
					return;
				}
				const reply = await postJson("/boss/assist/reply", { jobId: id, resumeName: selectedResume, conversation });
				setRemote((cur) => ({
					...(cur ?? {}),
					assistant: { ...(cur?.assistant ?? {}), running: false, jobId: id, conversation, reply: reply?.advice ?? null, error: reply?.ok === true ? null : (reply?.error ?? "回复建议生成失败") },
				}));
			};

			/**
			 * 把回复真的发给 Boss。
			 *
			 * 三层闸门，缺一不可：
			 *   1. 界面上必须点「发送给 Boss」，这里再弹一次 confirm（默认取消）；
			 *   2. 请求体必须显式带 `confirm: true`，宿主缺它一律 428 拒绝；
			 *   3. 宿主侧还有 3 秒最小间隔 + 2 分钟同内容去重。
			 *
			 * 复发不重试：MQTT 重发等于对 Boss 连发两条，宁可让用户自己再点一次。
			 */
			const sendReplyToBoss = async (id, friendId, text) => {
				const body = String(text ?? "").trim();
				if (body === "") return;
				if (remote?.assistant?.sending === true) return;
				const who = apps.find((a) => a.id === id);
				if (who !== undefined && who.real !== true) {
					setRemote((cur) => ({ ...(cur ?? {}), assistant: { ...(cur?.assistant ?? {}), jobId: id, sending: false, sendError: "这是演示岗位，没有对应会话，不能发送。" } }));
					return;
				}
				// eslint-disable-next-line no-alert
				if (typeof confirm === "function" && !confirm(`把这条消息发给「${who?.company ?? ""} ${who?.title ?? ""}」的 HR？\n\n${body}\n\n发出后无法撤回。`)) return;
				setRemote((cur) => ({ ...(cur ?? {}), assistant: { ...(cur?.assistant ?? {}), jobId: id, sending: true, sendError: null, sent: null } }));
				const j = await postJson("/boss/messages/reply", { friendId, text: body, confirm: true });
				setRemote((cur) => ({
					...(cur ?? {}),
					assistant: { ...(cur?.assistant ?? {}), jobId: id, sending: false, sent: j?.ok === true ? { text: j.text, at: j.sentAt } : null, sendError: j?.ok === true ? null : (j?.error ?? "发送失败") },
				}));
				if (j?.ok === true) setStatus(id, "sent", "已把回复发给对方，等下一步");
				else setStatus(id, "failed", j?.error ?? "发送失败", 1);
			};

			/** 生成打招呼话术：纯函数在宿主跑，这条路不联网。 */
			const generateGreeting = async (id) => {
				if (remote?.greet?.running === true) return;
				const target = apps.find((a) => a.id === id);
				if (target !== undefined && target.real !== true) {
					setRemote((cur) => ({ ...(cur ?? {}), greet: { running: false, jobId: id, ok: false, error: "这是演示岗位，不在岗位库里。先抓一批真岗位。" } }));
					return;
				}
				setRemote((cur) => ({ ...(cur ?? {}), greet: { running: true, jobId: id, error: null } }));
				const j = await postJson("/boss/greet/preview", { jobId: id, resumeName: selectedResume });
				setRemote((cur) => ({
					...(cur ?? {}),
					greet: { running: false, jobId: id, ok: j?.ok === true, text: j?.greeting?.text ?? null, error: j?.ok === true ? null : (j?.error ?? "话术生成失败") },
					greetText: j?.greeting?.text ?? cur?.greetText ?? null,
				}));
			};
			/** 发送打招呼。`text` 就是输入框里那段 —— 必须原样发出去。 */
			const sendGreetingNow = async (id, text) => {
				if (remote?.greet?.running === true) return;
				const body = String(text ?? "").trim();
				const who = apps.find((a) => a.id === id);
				// 演示岗位不是真岗位：它的 id 不在 data/jobs.json 里，宿主只会回 404。
				// 在第一层就拦住，别打一次注定失败的线上请求。
				if (who !== undefined && who.real !== true) {
					setRemote((cur) => ({ ...(cur ?? {}), greet: { running: false, jobId: id, ok: false, error: "这是演示岗位，不能发送。先点右上角「抓取岗位」抓一批真岗位。" } }));
					return;
				}
				// 空话术不发：以前这里会把空串发出去，宿主再自己 buildGreeting 兜底，
				// 结果"生成话术"如果失败（简历库还是空的），就是一次莫名其妙的线上请求。
				if (body === "") {
					setRemote((cur) => ({ ...(cur ?? {}), greet: { running: false, jobId: id, ok: false, error: "还没有话术：先点「生成话术」（需要简历库里有一份解析成功的简历），或者自己写一句再发。" } }));
					return;
				}
				// eslint-disable-next-line no-alert
				if (typeof confirm === "function" && !confirm(`给「${who?.company ?? ""} ${who?.title ?? ""}」发这条打招呼？\n\n${body}\n\n（只发消息，不会替你上传附件简历。）`)) return;
				setRemote((cur) => ({ ...(cur ?? {}), greet: { running: true, jobId: id, error: null } }));
				const j = await postJson("/boss/greet/send", { jobId: id, text: body, resumeName: selectedResume });
				setRemote((cur) => ({
					...(cur ?? {}),
					greet: { running: false, jobId: id, ok: j?.ok === true, text: body, error: j?.ok === true ? null : (j?.error ?? "打招呼失败") },
				}));
				if (j?.ok === true) setStatus(id, "sent", "打招呼已发出（不含附件简历）");
				else setStatus(id, "failed", j?.error ?? "打招呼失败", 1);
			};

			// 监听没有后台高频轮询：保存条件不联网，“检查新岗位”才发一次单页搜索。
			const saveCurrentWatch = async () => {
				const j = await postJson("/boss/watch/save", { mode: kw.trim() === "" ? "recommend" : "search", city: city ?? homeCity, query: kw.trim(), pageSize: 30, minIntervalMinutes: 360, ...jobFilters });
				if (j?.ok === true) setRemote((cur) => ({ ...(cur ?? {}), watch: j.watch, watchRun: { ok: true, message: "监听条件已保存；至少间隔 6 小时才能再次检查" } }));
			};
			const runCurrentWatch = async () => {
				if (remote?.watchRun?.running === true || coldActive) return;
				setRemote((cur) => ({ ...(cur ?? {}), watchRun: { running: true } }));
				const j = await postJson("/boss/watch/run");
				setRemote((cur) => ({
					...(cur ?? {}), jobs: j?.jobs ?? cur?.jobs ?? [], watch: j?.watch ?? cur?.watch ?? null,
					watchRun: { running: false, ok: j?.ok === true, newCount: j?.newCount ?? 0, error: j?.ok === true ? null : (j?.error ?? "监听检查失败") },
				}));
			};

			// ── 退出登录 ────────────────────────────────────────────────────
			// 刻意**不加 useState**：状态挂进已有的 remote 里，WorkbenchPage 的 hook
			// 序号（0-10 归本组件，11 起归子组件）就不能再动了。
			const logout = remote?.logout ?? null;
			const loggingOut = logout?.running === true;
			const doLogout = async () => {
				if (loggingOut) return;
				// eslint-disable-next-line no-alert
				if (typeof confirm === "function" && !confirm("解除插件与 Boss 会话的绑定？\n\n只清插件保存的会话，不会退出或清理你真实 Chrome 里的 Boss。\n简历库和已抓到的岗位不动。")) return;
				setRemote((cur) => ({ ...(cur ?? {}), logout: { running: true } }));
				const j = await postJson("/boss/logout");
				setRemote((cur) => ({
					...(cur ?? {}),
					logout: { running: false, at: Date.now(), ok: j?.ok === true, clearedCookies: j?.clearedCookies ?? null, error: j?.ok === true ? null : "宿主 /boss/logout 没响应（重启一次 GUI？）" },
					// 立刻把"已登录"的痕迹抹掉，否则表头还在说登录着
					session: { present: false },
					scrape: null,
				}));
			};

			/**
			 * 状态迁移：改状态 + 补一条时间线。
			 *
			 * ⚠️ 这里**不再有假定时器**：以前 send/retry 走 `schedule(…, 900)` 把状态推到
			 * "简历与打招呼语已发送"，看起来像真发出去了 —— 其实一个网络请求都没发，
			 * 而且插件根本没有上传简历附件的代码。现在这四个动作都走真路由，
			 * 成功失败由宿主的响应决定；文案也改成只说真发生的事。
			 */
			const setStatus = (id, status, text, flag) =>
				setApps((cur) => cur.map((a) => (a.id === id ? { ...a, status, timeline: [...a.timeline, [stamp(), text, flag ?? 0]] } : a)));

			const applyAction = (id, what) => {
				// 确认发送 = 把当前打招呼语真的发出去（不含附件简历）。
				// 发的是**输入框里那段**：你改过就用你改的，没改就是生成的那段。
				// 空的话 sendGreetingNow 会告诉你先去生成，不会发空消息上线。
				if (what === "send" || what === "retry") {
					const current = apps.find((a) => a.id === id);
					const text = (remote?.greet?.jobId === id ? remote?.greet?.text : null) ?? remote?.greetText ?? current?.greeting ?? "";
					sendGreetingNow(id, text);
					return;
				}
				// 去回话 = 把当前岗位的会话读出来并生成建议（不自动发消息）。
				if (what === "reply") {
					loadConversationAndAdvice(id);
					return;
				}
				if (what === "skip") {
					setStatus(id, "skipped", "你跳过了这个岗位");
					return;
				}
				if (what === "regenerate") {
					setStatus(id, "preparing", "正在按 JD 润色结构化简历");
					tailorResume(id).then((result) => {
						if (result?.ok === true) setStatus(id, "review", "按 JD 润色的简历已生成，等你确认", 1);
						else setStatus(id, "failed", result?.error ?? "简历润色失败", 1);
					});
					return;
				}
				if (what === "swapResume") {
					setApps((cur) =>
						cur.map((a) => {
							if (a.id !== id) return a;
							const next = RESUMES[(RESUMES.indexOf(a.resume) + 1 + RESUMES.length) % RESUMES.length];
							return { ...a, resume: next, timeline: [...a.timeline, [stamp(), "换简历：" + next, 0]] };
						}),
					);
				}
			};

			/**
			 * 顶部计数 = 状态筛选。点当前档取消，回到全部；切换后如果选中的 JD
			 * 被筛掉，就把焦点交给第一条可见的，避免中右两栏对着一个看不见的项。
			 */
			const pickFilter = (key) => {
				const next = filter === key ? null : key;
				setFilter(next);
				refocus({ ...query, filter: next });
			};

			/** 点卡片上的状态标签：选中它 + 只看这个状态 + 把它的动作行用脉冲指出来。 */
			const pickStatus = (id, status) => {
				setSelectedId(id);
				setFilter(status);
				setFocusAction((n) => n + 1);
			};

			/**
			 * 哪一段该亮着。聚合档（需要我 / 等待回复）在"只看某个具体状态"时
			 * 也要亮 —— 否则点了「已回复」标签，表头却显示「全部」，自相矛盾。
			 */
			const segOn = (key) => {
				if (key === null) return filter === null;
				if (filter === null) return false;
				if (filter === key) return true;
				// filter 可能是聚合档（needs / waiting）而不是具体状态 —— 那种情况不归属任何聚合档
				return Object.prototype.hasOwnProperty.call(STATUS, filter) ? (FILTERS[key]?.match({ status: filter }) ?? false) : false;
			};

			const seg = (key, label, count, hot) =>
				h(
					"button",
					{
						type: "button",
						className: "bw_tally" + (hot ? " bw_tallyHot" : "") + (segOn(key) ? " bw_tallyOn" : ""),
						"aria-pressed": segOn(key),
						onClick: () => pickFilter(key),
					},
					hot ? h("span", { className: "bw_dot" }) : null,
					label,
					h("span", null, String(count)),
				);
			/**
			 * 七个维度的下拉项**从宿主拿**（/boss/state 的 filterSpecs ← boss/lib.mjs 的 FILTER_SPECS）。
			 *
			 * 之前这里手写了一份，行业只有 7 个 —— 而宿主字典里有 23 个，剩下 16 个
			 * 用户永远选不到。现在选项和编码表在同一个文件里，两边不可能再各自漂移。
			 * 宿主还没起来时退回一份最小的兜底，保证界面不空。
			 */
			const bossFilterSpecs = (remote?.filterSpecs ?? []).map((spec) => [spec.key, spec.label, spec.options]);
			const fallbackFilterSpecs = [
				["salary", "薪资", ["3K以下", "3-5K", "5-10K", "10-15K", "15-20K", "20-30K", "30-50K", "50K以上"]],
				["experience", "经验", ["在校/应届", "1年以内", "1-3年", "3-5年", "5-10年", "10年以上"]],
				["degree", "学历", ["初中及以下", "中专/中技", "高中", "大专", "本科", "硕士", "博士"]],
				["jobType", "类型", ["全职", "实习", "兼职"]],
				["industry", "行业", ["互联网", "软件/信息服务", "人工智能", "大数据", "云计算", "金融", "制造业"]],
				["scale", "规模", ["0-20人", "20-99人", "100-499人", "500-999人", "1000-9999人", "10000人以上"]],
				["stage", "融资", ["未融资", "天使轮", "A轮", "B轮", "C轮", "D轮及以上", "已上市", "不需要融资"]],
			];
			const filterSpecs = bossFilterSpecs.length > 0 ? bossFilterSpecs : fallbackFilterSpecs;

			return h(
				"div",
				{ className: "bw_page" },
				h(
					"div",
					{ className: "bw_head" },
					h("span", { className: "bw_title" }, "Boss 直聘工作台"),
					h(
						"button",
						{
							type: "button",
							className: "bw_btn bw_btnGo" + (scraping ? " bw_btnBusy" : "") + (coldActive ? " bw_btnCold" : ""),
							disabled: canScrape === false,
							title: coldActive
								? `冷却中（约 ${coldMinutes} 分钟）：上一次撞到 ${cold?.message ?? cold?.kind ?? "风控"}。风控按频率扣分，等一等再抓。`
								: kw.trim() === "" ? "没有关键词，就抓 Boss 的推荐流" : "去 Boss 搜「" + kw.trim() + "」",
							onClick: () => doScrape(),
						},
						scraping ? "抓取中…" : coldActive ? "冷却中" : "抓取岗位",
					),
					h("span", { className: "bw_spacer" }),
					h(WorkbenchBalance, null),
					// 只有真的存着会话时才给"退出" —— 没登录的时候摆一个退出按钮没有意义
					remote?.session?.present === true
						? h(
								"button",
								{
									type: "button",
									className: "bw_logout",
									disabled: loggingOut,
									title: "解除插件绑定，不退出真实 Chrome 中的 Boss",
									onClick: () => doLogout(),
								},
								loggingOut ? "解除中…" : "解除绑定",
							)
						: null,
					h(
						"div",
						{ className: "bw_tallies" },
						seg("needs", "需要我", hotCount, true),
						seg("waiting", "等待回复", sentCount, false),
						seg(null, "全部", apps.length, false),
					),
				),
				// 抓取条件：城市 / 岗位关键词 / 距离。真实值来自 boss/scrape.mjs 写出的 data/jobs.json
				h(
					"div",
					{ className: "bw_filters" },
					h(
						"span",
						{ className: "bw_field" },
						h("span", { className: "bw_fieldK" }, "城市"),
						h(
							"select",
							{
								className: "bw_select",
								value: city ?? "",
								onChange: (e) => {
									const v = e.target.value === "" ? null : e.target.value;
									setCity(v);
									refocus({ ...query, city: v });
								},							},
							h("option", { value: "" }, "不限"),
							cityOptions.map((c) => h("option", { key: c, value: c }, c)),
						),
					),
					h(
						"span",
						{ className: "bw_field" },
						h("span", { className: "bw_fieldK" }, "岗位"),
						h("input", {
							className: "bw_kw",
							value: kw,
							placeholder: "公司 / 职位 / JD 关键词，回车去 Boss 搜",
							onChange: (e) => setKw(e.target.value),
							onKeyDown: (e) => {
								if (e.key === "Enter") doScrape();
							},
						}),
						h(
							"button",
							{
								type: "button",
								className: "bw_kwGo",
								disabled: canScrape === false,
								title: kw.trim() === "" ? "留空 → 抓推荐流" : "去 Boss 搜「" + kw.trim() + "」",
								onClick: () => doScrape(),
							},
							scraping ? "…" : "搜",
						),
					),
					h(
						"span",
						{ className: "bw_field" },
						h("span", { className: "bw_fieldK" }, "距离"),
						h(
							"select",
							{
								className: "bw_select",
								value: maxKm === null ? "" : String(maxKm),
								onChange: (e) => {
									const v = e.target.value === "" ? null : Number(e.target.value);
									setMaxKm(v);
									refocus({ ...query, maxKm: v });
								},
							},
							DISTANCE_OPTIONS.map((o) => h("option", { key: String(o.km), value: o.km === null ? "" : String(o.km) }, o.label)),
						),
					),
					...filterSpecs.map(([key, label, options]) =>
						h(
							"span",
							{ className: "bw_field", key },
							h("span", { className: "bw_fieldK" }, label),
							h(
								"select",
								{ className: "bw_select", value: jobFilters[key] ?? "", onChange: (e) => setJobFilter(key, e.target.value) },
								h("option", { value: "" }, "不限"),
								options.map((option) => h("option", { key: option, value: option }, option)),
							),
						),
					),
					h("span", { className: "bw_count" }, "筛出 " + String(shownCount) + " / 共 " + String(apps.length) + " 个岗位"),
					h("button", { type: "button", className: "bw_btn", onClick: saveCurrentWatch }, "保存监听"),
					h("button", { type: "button", className: "bw_btn", disabled: remote?.watchRun?.running === true || coldActive || remote?.watch === null || remote?.watch === undefined, onClick: runCurrentWatch }, remote?.watchRun?.running === true ? "检查中…" : "检查新岗位"),
				),
				// 冷却期：撞过风控就把抓取锁上。这条带子解释"为什么按钮点不动" ——
				// 不解释的话，用户只会觉得是 bug，然后去别处找办法硬试。
				coldActive
					? h(
							"div",
							{ className: "bw_scrape bw_scrapeBad" },
							h("span", { className: "bw_scrapeDot" }),
							h(
								"span",
								null,
								`风控冷却中（约 ${coldMinutes} 分钟后解禁）· 上次：${cold?.message ?? cold?.kind ?? "?"} · 这期间抓取被锁住，风控按频率扣分，"再试一次"只会更糟`,
							),
						)
					: null,
				// 连不上 Chrome：说清楚是哪一步断了、怎么修。
				// 「帮我启动 Chrome」是关键 —— 用户不该为了用插件去敲命令行（见 boss/auto-chrome.mjs）。
				offline !== null && offline.reason
					? h(
							"div",
							{ className: "bw_scrape bw_scrapeBad" },
							h("span", { className: "bw_scrapeDot" }),
							h(
								"span",
								null,
								"连不上本机 Chrome 调试会话" +
									(offline.code ? `（${offline.code}）` : "") +
									`：${offline.reason}` +
									"　·　插件会自动用「插件自己的」窗口拉起一个可调试的 Chrome（不碰你日常那个窗口）。" +
									"工作台里已抓到的岗位、简历库和监听条件都还在，不受影响。",
							),
							h(
								"button",
								{
									type: "button",
									className: "bw_btn bw_btnPrimary",
									onClick: async () => {
										dismissOffline();
										// force=1：绕过状态缓存，重新走一次"连不上就自己拉起"
										await postJson("/boss/login/start?force=1");
										loadState();
									},
								},
								"帮我启动 Chrome",
							),
							h("button", { type: "button", className: "bw_btn", onClick: dismissOffline }, "先不管"),
						)
					: null,
				// 退出登录的结果条（成功/失败各说各的，别让按钮点下去没交代）
				logout !== null && logout.running !== true && logout.at !== undefined
					? h(
							"div",
							{ className: "bw_scrape" + (logout.ok === true ? " bw_scrapeOk" : " bw_scrapeBad") },
							h("span", { className: "bw_scrapeDot" }),
							h(
								"span",
								null,
								logout.ok === true
									? "已解除插件绑定（真实 Chrome 的 Boss 登录态未改动）· 简历库和岗位列表没动"
									: String(logout.error ?? "退出失败"),
							),
						)
					: null,
				// 抓取进度与结果。这里也是"为什么没抓到"的唯一出口 ——
				// 风控 code 35、登录失效、环境异常 code 37 都会原样显示在这儿。
				scrape === null
					? null
					: h(
							"div",
							{
								className:
									"bw_scrape" +
									(scrape.error === null || scrape.error === undefined ? " bw_scrapeOk" : "") +
									(scrape.flagged === true ? " bw_scrapeBad" : ""),
							},
							h("span", { className: "bw_scrapeDot" }),
							scrape.running === true
								? h(
										"span",
										null,
										(scrape.query === "" ? "正在抓 Boss 推荐流" : "正在 Boss 搜「" + scrape.query + "」") +
											"（" + String(scrape.city ?? "不限城市") + "，1 页）…",
									)
								: scrape.error === null || scrape.error === undefined
									? h(
											"span",
											null,
											(scrape.mode === "recommend" ? "推荐流" : "搜索「" + scrape.query + "」") +
												"：抓到 " + String(scrape.fetched) + " 条（新增 " + String(scrape.added) + "，库里共 " + String(scrape.total) + "） · " +
												String(((scrape.ms ?? 0) / 1000).toFixed(1)) + "s",
										)
									: h("span", null, "没抓到：" + scrape.error),
						),
				remote?.watchRun !== null && remote?.watchRun !== undefined && remote.watchRun.running !== true
					? h("div", { className: "bw_scrape" + (remote.watchRun.error ? " bw_scrapeBad" : " bw_scrapeOk") }, h("span", { className: "bw_scrapeDot" }), remote.watchRun.error ?? remote.watchRun.message ?? (`监听检查完成：发现 ${String(remote.watchRun.newCount ?? 0)} 个新岗位`))
					: null,
				h(
					"div",
					{ className: "bw_cols" },
					h(QueueColumn, {
						apps,
						selectedId,
						onPick: setSelectedId,
						onPickStatus: pickStatus,
						filter,
						onClearFilter: () => pickFilter(null),
						city,
						kw,
						maxKm,
						jobFilters,
						onClearQuery: clearQuery,
						onScrape: doScrape,
						scraping,
						hasReal,
						canScrape,
						coldActive,
					}),
					h(DetailColumn, {
						app: selected,
						focusAction,
						onAct: applyAction,
						resumeName: selectedResume,
						onFetchDetail: fetchDetail,
						detailLoading: remote?.detail?.running === true && remote?.detail?.id === selected?.id,
						assistant: remote?.assistant ?? null,
						onConversation: loadConversationAndAdvice,
						remote,
						replyText: remote?.replyText ?? null,
						onReplyText: (value) => setRemote((cur) => ({ ...(cur ?? {}), replyText: value })),
						onSendReply: sendReplyToBoss,
						greetText: remote?.greetText ?? null,
						onGreetText: (value) => setRemote((cur) => ({ ...(cur ?? {}), greetText: value })),
						onGenerateGreeting: generateGreeting,
						onSendGreeting: sendGreetingNow,
					}),
					// 右栏是"证据 + 素材"：上半跟着选中项走，下半（简历库）永远在
					h(
						"div",
						{ className: "bw_colStack" },
						h(ProgressColumn, { app: selected, onAct: applyAction }),
						h(ResumeLibrary, {
							state: remote,
							uploads,
							onFiles: uploadFiles,
							onDelete: deleteResume,
							onRescan: rescanResumes,
							selectedResume,
							onSelect: setSelectedResume,
							collapsed: libCollapsed,
							onToggle: () => setLibCollapsed((v) => !v),
						}),
					),
				),
				// 登录闸门放最后：它的 hook 排在简历库之后，前面那些按序号驱动的用例不受影响
				h(LoginGate, {
					onLoggedIn: loadState,
					onUnavailable: (info) => setRemote((cur) => ({ ...(cur ?? {}), offline: info })),
					reloadKey: remote?.logout?.at ?? 0,
				}),
			);
		}
		//#endregion

		//#region 左侧导航图标（注册进 'sidebar.panellist'，该席位当前零占用）
		/** 导航图标；按钮本体与点击行为由 sidebar 自己拥有。 */
		function WorkbenchIcon({ size }) {
			const s = size ?? 20;
			return h(
				"svg",
				{ width: s, height: s, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
				h("path", {
					d: "M3 7.2h14v8.3a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5V7.2Z",
					stroke: "currentColor",
					"stroke-width": "1.4",
					"stroke-linejoin": "round",
				}),
				h("path", {
					d: "M7.4 7.2V5.6a1.5 1.5 0 0 1 1.5-1.5h2.2a1.5 1.5 0 0 1 1.5 1.5v1.6",
					stroke: "currentColor",
					"stroke-width": "1.4",
					"stroke-linejoin": "round",
				}),
				h("path", { d: "M3 10.6h14", stroke: "currentColor", "stroke-width": "1.4" }),
			);
		}
		//#endregion

		//#region 悬浮提醒（注册进 'shell.overlay'）
		/**
		 * 提醒栈。`shell.overlay` 层本身是点击穿透的，所以每个 toast
		 * 自己重新打开指针事件。三类事件对应状态机里三个"阻塞在人类"的状态。
		 */
		function ToastStack() {
			const [items, setItems] = react.useState([
				{ id: "t1", title: "云启数据 回复了你", text: "数据平台工程师 · 11:30", act: "去回话" },
				{ id: "t2", title: "3 个 JD 待你确认", text: "简历与话术已就绪", act: "批量确认" },
				{ id: "t3", title: "某某网络 发送失败", text: "登录态已失效", act: "查看并重试" },
			]);
			const drop = (id) => setItems((cur) => cur.filter((x) => x.id !== id));
			if (items.length === 0) return null;
			return h(
				"div",
				{ className: "bw_toasts" },
				items.map((it) =>
					h(
						"div",
						{ className: "bw_toast", key: it.id },
						h(
							"div",
							{ className: "bw_toastBody" },
							h("div", { className: "bw_toastTitle" }, it.title),
							h("div", { className: "bw_toastText" }, it.text),
							h("div", { className: "bw_toastAct" }, h("button", { type: "button", className: "bw_btn", onClick: () => drop(it.id) }, it.act)),
						),
						h("button", { type: "button", className: "bw_toastX", "aria-label": "关闭", onClick: () => drop(it.id) }, "\u00d7"),
					),
				),
			);
		}
		//#endregion

		//#region 插件主体
		/** 需要的 Cordis 客户端服务。 */
		const inject = ["slots"];

		/**
		 * 客户端插件主体：把工作台注册到三个官方席位。
		 * @param ctx - 客户端 root context。
		 */
		function apply(ctx) {
			// 左侧导航图标 + 全屏工作台页。panellist 的 list id 与 main 的 key
			// 同名，sidebar 据此把两者配成一对：点图标即 selectPanel(该 key)。
			ctx.slots.inject("sidebar.panellist", () =>
				ctx.slots.register({ name: "sidebar.panellist", id: "boss-workbench", order: 40, label: () => PANEL_LABEL }, WorkbenchIcon),
			);
			ctx.slots.inject("main", () => ctx.slots.register({ name: "main", key: "boss-workbench" }, WorkbenchPage));

			// 悬浮提醒层。
			ctx.slots.inject("shell.overlay", () =>
				ctx.slots.register({ name: "shell.overlay", id: "boss-workbench-toasts", order: 60 }, ToastStack),
			);

			// 会话区右下角的余额。`conversation.composer.dock` 是"输入框下方的 ambient 区"，
			// shell 自己的「用量 · 缓存命中」（StatsPills）就注册在这里 —— 我们做它的邻居。
			ctx.slots.inject("conversation.composer.dock", () =>
				ctx.slots.register({ name: "conversation.composer.dock", id: "boss-workbench-balance", order: 90 }, BalancePill),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
