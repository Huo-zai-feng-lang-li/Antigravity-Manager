#!/usr/bin/env node
/**
 * Release Version Consistency Checker
 * 
 * 校验发版所需的各个版本源是否严格一致：
 * 1. package.json (.version)
 * 2. src-tauri/Cargo.toml ([package].version)
 * 3. src-tauri/tauri.conf.json (.version)
 * 4. Git Tag (若由 tag 触发，如 v4.8.31，剥离 'v' 前缀后必须与上述三者一致)
 * 5. CHANGELOG.md (必须包含对应版本的更新日志)
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

// ANSI 颜色辅助函数
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};

function logSuccess(msg) {
  console.log(`${colors.green}  [OK]${colors.reset} ${msg}`);
}

function logError(msg) {
  console.error(`${colors.red}  [FAIL]${colors.reset} ${colors.bold}${msg}${colors.reset}`);
}

function logWarning(msg) {
  console.warn(`${colors.yellow}  [WARN]${colors.reset} ${msg}`);
}

function logInfo(msg) {
  console.log(`${colors.blue}  [INFO]${colors.reset} ${msg}`);
}

// 1. 读取 package.json
function getPackageJsonVersion() {
  const filePath = path.join(ROOT_DIR, 'package.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!content.version) {
    throw new Error(`No "version" field in ${filePath}`);
  }
  return { version: content.version.trim(), file: 'package.json' };
}

// 2. 读取 src-tauri/tauri.conf.json
function getTauriConfVersion() {
  const filePath = path.join(ROOT_DIR, 'src-tauri', 'tauri.conf.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!content.version) {
    throw new Error(`No "version" field in ${filePath}`);
  }
  return { version: content.version.trim(), file: 'src-tauri/tauri.conf.json' };
}

// 3. 读取 src-tauri/Cargo.toml 中的 [package].version
function getCargoTomlVersion() {
  const filePath = path.join(ROOT_DIR, 'src-tauri', 'Cargo.toml');
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const content = fs.readFileSync(filePath, 'utf8');

  // 提取 [package] 到下一个 [xxx] 之间的内容
  const packageSectionMatch = content.match(/\[package\]([\s\S]*?)(?=\n\[|$)/);
  if (!packageSectionMatch) {
    throw new Error(`Could not find [package] section in ${filePath}`);
  }

  const versionMatch = packageSectionMatch[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!versionMatch) {
    throw new Error(`Could not find "version" under [package] in ${filePath}`);
  }

  return { version: versionMatch[1].trim(), file: 'src-tauri/Cargo.toml' };
}

// 4. 解析目标 Tag（从环境变量或命令行参数中提取）
function getTargetTag() {
  // 优先支持命令行参数: node check-version.mjs --tag v4.8.31
  const args = process.argv.slice(2);
  const tagArgIdx = args.indexOf('--tag');
  if (tagArgIdx !== -1 && args[tagArgIdx + 1]) {
    return args[tagArgIdx + 1].trim();
  }

  // GitHub Actions 环境变量
  const refType = process.env.GITHUB_REF_TYPE;
  const refName = process.env.GITHUB_REF_NAME;

  if (refType === 'tag' && refName) {
    return refName.trim();
  }

  if (refName && refName.startsWith('v')) {
    return refName.trim();
  }

  return null;
}

// 5. 检查 Changelog 文件是否包含该版本
function checkChangelogEntry(filename, version) {
  const changelogPath = path.join(ROOT_DIR, filename);
  if (!fs.existsSync(changelogPath)) {
    return { found: false, warning: `${filename} does not exist` };
  }
  const content = fs.readFileSync(changelogPath, 'utf8');
  // 匹配常见的日志标题样式：
  // **v4.8.31
  // ## [4.8.31]
  // ## v4.8.31
  const escapedVer = version.replace(/\./g, '\\.');
  const regex = new RegExp(`(\\*\\*v?${escapedVer}\\b|##\\s+\\[?v?${escapedVer}\\]?)`, 'i');
  return { found: regex.test(content) };
}

// 主校验流程
function main() {
  console.log(`\n${colors.bold}========================================================${colors.reset}`);
  console.log(`${colors.bold}       Antigravity Release Version Consistency Check    ${colors.reset}`);
  console.log(`${colors.bold}========================================================${colors.reset}\n`);

  let hasErrors = false;

  // 读取三方文件版本
  let pkgInfo, tauriInfo, cargoInfo;
  try {
    pkgInfo = getPackageJsonVersion();
    tauriInfo = getTauriConfVersion();
    cargoInfo = getCargoTomlVersion();
  } catch (err) {
    logError(`Failed to read project version files: ${err.message}`);
    process.exit(1);
  }

  const versions = [
    { label: 'package.json', version: pkgInfo.version, file: pkgInfo.file },
    { label: 'tauri.conf.json', version: tauriInfo.version, file: tauriInfo.file },
    { label: 'Cargo.toml', version: cargoInfo.version, file: cargoInfo.file },
  ];

  // 1. 检查三大文件版本一致性
  const baseVersion = pkgInfo.version;
  console.log(`${colors.bold}1. Core Configuration Files:${colors.reset}`);
  for (const item of versions) {
    if (item.version === baseVersion) {
      logSuccess(`${item.label.padEnd(18)} : ${colors.bold}${item.version}${colors.reset} (${item.file})`);
    } else {
      logError(`${item.label.padEnd(18)} : ${colors.bold}${item.version}${colors.reset} (Expected: ${baseVersion} from ${pkgInfo.file})`);
      hasErrors = true;
    }
  }

  // 2. 检查 Tag 与文件版本一致性
  console.log(`\n${colors.bold}2. Git Release Tag Audit:${colors.reset}`);
  const targetTag = getTargetTag();
  if (targetTag) {
    const rawTagVersion = targetTag.startsWith('v') ? targetTag.slice(1) : targetTag;
    if (rawTagVersion === baseVersion) {
      logSuccess(`Release Tag "${targetTag}" matches project version: ${colors.bold}${baseVersion}${colors.reset}`);
    } else {
      logError(`Release Tag "${targetTag}" (parsed: ${rawTagVersion}) does NOT match project version (${baseVersion})!`);
      logError(`Release aborted to prevent deploying mismatched binaries.`);
      hasErrors = true;
    }
  } else {
    logInfo(`No Git Tag detected or non-tag trigger (ref_type: ${process.env.GITHUB_REF_TYPE || 'local'}). Skipping Tag mismatch check.`);
  }

  // 3. 检查 CHANGELOG.md 与 CHANGELOG_EN.md 是否记录该版本
  console.log(`\n${colors.bold}3. Bilingual Changelog Documentation Audit:${colors.reset}`);
  const targetCheckVer = (targetTag && targetTag.startsWith('v')) ? targetTag.slice(1) : baseVersion;
  const changelogFiles = ['CHANGELOG.md', 'CHANGELOG_EN.md'];

  for (const file of changelogFiles) {
    const result = checkChangelogEntry(file, targetCheckVer);
    if (result.found) {
      logSuccess(`${file.padEnd(16)} contains release entry for v${targetCheckVer}`);
    } else {
      if (targetTag) {
        logError(`${file.padEnd(16)} is missing release entry for v${targetCheckVer}!`);
        logError(`According to project constitution, every release must document its changes in both CHANGELOG.md and CHANGELOG_EN.md.`);
        hasErrors = true;
      } else {
        logWarning(`${file.padEnd(16)} has no explicit heading for v${targetCheckVer}. (Acceptable in local development mode)`);
      }
    }
  }

  console.log(`\n${colors.bold}========================================================${colors.reset}`);

  if (hasErrors) {
    console.error(`\n${colors.red}${colors.bold}❌ VERSION CONSISTENCY CHECK FAILED!${colors.reset}`);
    console.error(`${colors.yellow}Please ensure package.json, src-tauri/Cargo.toml, src-tauri/tauri.conf.json, and the Git Tag are all synchronized.${colors.reset}\n`);
    process.exit(1);
  }

  console.log(`\n${colors.green}${colors.bold}✅ ALL VERSION CHECKS PASSED! (Version: ${baseVersion})${colors.reset}\n`);
  process.exit(0);
}

main();
