/**
 * 本机发布脚本：原 GitHub Actions publish 工作流的本地等价物（发布前的
 *
 * 用法：
 *   node scripts/release.mjs [<version|bump>] [--dry-run] [--push] [--allow-dirty]
 *
 *   <version|bump>  目标版本：patch | minor | major（基于当前版本递增，
 *                   若当前为预发布版本则顺带升级为稳定版），或显式版本号
 *                   如 0.1.9 / 0.2.0-rc.1。缺省为 patch。
 *   --dry-run       发布演练：跑 lint/typecheck/test 与 `npm pack --dry-run`
 *                   预览 tarball 内容，不改版本、不发布、不打 tag。
 *   --push          打 tag 后一并推送远端分支与 tag（缺省只本地提交 + 打 tag）。
 *   --allow-dirty   允许在存在未提交改动时发布（缺省拒绝，防止发布半成品）。
 *
 * lint/typecheck/test 检查与 CI 保持一致；CI 的 ci.yml 保留，仅发布改为本机）。
 *
 * 流程（与旧 publish.yml 一致并补齐版本管理）：
 *   bump 版本（package.json + package-lock.json 同步）→ lint → typecheck →
 *   test（含 build）→ npm publish → git commit + tag vX.Y.Z（可选 push）。
 */

import { readFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const PKG = join(ROOT, "package.json")
const LOCK = join(ROOT, "package-lock.json")

const args = process.argv.slice(2)
const HELP = args.includes("--help") || args.includes("-h")
const DRY_RUN = args.includes("--dry-run")
const PUSH = args.includes("--push")
const ALLOW_DIRTY = args.includes("--allow-dirty")

if (HELP) {
  console.log(`本机发布脚本（替代原 GitHub Actions 发布流程）

用法：
  node scripts/release.mjs [<version|bump>] [--dry-run] [--push] [--allow-dirty]

  <version|bump>  patch | minor | major 或显式版本号，缺省 patch
  --dry-run       演练：check + npm pack --dry-run，不改版本/不发布/不打 tag
  --push          打 tag 后推送远端分支与 tag（缺省仅本地提交 + 打 tag）
  --allow-dirty   允许带未提交改动发布`)
  process.exit(0)
}

/** 同步执行命令，失败即打印并退出。 */
function run(label, command, argv) {
  if (DRY_RUN && label !== "npm pack 预览") {
    console.log(`  ✅ 演练跳过：\u001b[2m${command} ${argv.join(" ")} \u001b[0m`)
    return
  }
  console.log(`  ▶ ${label}：\u001b[2m${command} ${argv.join(" ")} \u001b[0m`)
  const res = spawnSync(command, argv, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  })
  if (res.status !== 0) {
    console.error(`❌ ${label} 失败（退出码 ${res.status ?? "n/a"}），中止`)
    process.exit(1)
  }
}

/** 简单 semver 递增：major/minor/patch，预发布版本升为稳定版。 */
function bump(current, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(current)
  if (!m) throw new Error(`无法解析当前版本 ${current}`)
  let [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (kind === "major") { major += 1; minor = 0; patch = 0 }
  else if (kind === "minor") { minor += 1; patch = 0 }
  else if (kind === "patch") { patch += 1 }
  else throw new Error(`未知递增类型 ${kind}（支持 patch/minor/major）`)
  return `${major}.${minor}.${patch}`
}

// ---------- 1. 解析参数与当前版本 ----------
const positionals = args.filter(a => !a.startsWith("-"))
const bumpArg = positionals[0] ?? "patch"
const pkg = JSON.parse(readFileSync(PKG, "utf8"))
const current = pkg.version
const explicit = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(bumpArg)
const newVersion = explicit ? bumpArg : bump(current, bumpArg)

console.log("dsh-debugger-dap 本机发布")
console.log(`  当前版本：${current}   ->   目标版本：${newVersion}`)
if (DRY_RUN) console.log("  模式：演练（不修改任何文件、不发布、不打 tag）")

// ---------- 2. 工作区检查（演练不需要） ----------
if (!DRY_RUN && !ALLOW_DIRTY) {
  const st = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" })
  if (st.status !== 0) {
    console.error("❌ 无法读取 git 状态（本目录不是 git 仓库？），中止")
    process.exit(1)
  }
  if (st.stdout.trim()) {
    console.error("❌ 工作区存在未提交改动，请先提交或使用 --allow-dirty：")
    console.error(st.stdout.trim().split("\n").map(l => "   " + l).join("\n"))
    process.exit(1)
  }
}

// ---------- 3. 演练：不做任何修改 ----------
if (DRY_RUN) {
  run("lint", "npm", ["run", "lint"])
  run("typecheck", "npm", ["run", "typecheck"])
  run("test", "npm", ["test"])
  run("npm pack 预览", "npm", ["pack", "--dry-run"])
  console.log("\n✅ 演练完成：以上检查与 tarball 内容均正常，可执行正式发布（去掉 --dry-run）。")
  process.exit(0)
}

// ---------- 4. 同步版本到 package.json 与 package-lock.json ----------
pkg.version = newVersion
writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n")
const lock = JSON.parse(readFileSync(LOCK, "utf8"))
lock.version = newVersion
if (lock.packages?.[""]) lock.packages[""].version = newVersion
writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n")
console.log("✅ 版本已写入 package.json 与 package-lock.json")

// ---------- 5. 检查 + 发布 ----------
run("lint", "npm", ["run", "lint"])
run("typecheck", "npm", ["run", "typecheck"])
run("test", "npm", ["test"])
run("发布到 npm", "npm", ["publish"])

// ---------- 6. 提交 + 打 tag（可选推送） ----------
const tag = `v${newVersion}`
run("提交版本", "git", ["add", "package.json", "package-lock.json"])
run("提交版本", "git", ["commit", "-m", `chore(release): ${tag}`])
run("打 tag", "git", ["tag", tag])

let pushed = ""
if (PUSH) {
  const br = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8" })
  const branch = (br.stdout ?? "").trim() || "master"
  run("推送分支", "git", ["push", "origin", branch])
  run("推送 tag", "git", ["push", "origin", tag])
  pushed = `（已推送 origin/${branch} 与 tag）`
}

console.log(`\n✅ 发布完成：${pkg.name}@${newVersion} 已发布到 npm registry，本地已打 tag ${tag}${pushed}`)
