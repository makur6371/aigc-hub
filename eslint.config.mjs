import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 本地临时脚本/产物（已在 .gitignore，非项目源码）
    "tmp/**",
    ".e2e-tmp/**",
    // 供应商适配器模板参考文件（第三方文档，非本仓库源码）
    "模板.ts",
    // 浏览器侧的第三方成品（mediapipe 的 wasm 胶水层等）：这是压缩过的供应商产物，
    // 不是我们的代码，也不会被我们的构建链路解析。之前它一个人贡献了 5 条错误
    // （含一条 `react-hooks/rules-of-hooks` 误报：它内部有个叫 `useProgram` 的 WebGL 函数），
    // 让 lint 的signal 被噪音淹没。
    "public/**",
  ]),
  {
    // `.cjs` 就是 CommonJS —— `require()` 是它的正确写法，不是需要改的坏味道。
    // eslint-config-next 的 TS 规则集把 `no-require-imports` 也套到了 scripts/ 与 tests/ 的
    // `.cjs` 上，一个人贡献了 49 条错误，把真正需要看的 30 条 src 问题埋掉了。
    // 只在这类文件里关，src/**（ESM）的 require 禁令照旧生效。
    files: ["**/*.cjs"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    // Q-D24：节点卡身的 *Body / *ParamBar / *PromptPanel 都是自带 Hook 的子组件，
    // 只允许以 JSX 渲染。Foo(ctx) 普通调用会把 Hook 挂进调用方的 Hook 序列，
    // 在 cardOpen 条件渲染下就是「Hook 顺序被破坏」事故本身。
    // 编辑器/CI lint 实时拦截（vitest 守卫 tests/canvas-dispatch-components.test.ts 是第二道防线）。
    //
    // ⚠ 路径必须跟着拆分走（Q-303）：node-bodies.tsx 已变成 13 行 barrel，
    // 规则若还只盯那个文件，就**只扫得到转发语句**、真正含组件的
    // node-bodies/*.tsx 全都失去保护 —— 与「源码守卫换了目录就静默空跑」是同一类坑。
    files: ["src/components/canvas/node-bodies.tsx", "src/components/canvas/node-bodies/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "CallExpression[callee.type='Identifier'][callee.name=/(Body|ParamBar|PromptPanel)$/]",
        message: "节点体/参数条/填写面板组件必须用 JSX 渲染（<Foo {...ctx} />），禁止 Foo(ctx) 普通调用 —— 会破坏 Hook 顺序",
      }],
    },
  },
]);

export default eslintConfig;
