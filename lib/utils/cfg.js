import fs from "node:fs"
import path from "node:path"
import _ from "lodash"
import YAML from "yaml"
import chokidar from "chokidar"

/**
 * 插件内配置（与 napcat-adapter / snowluma-adapter 同一套写法）
 *
 *   config/defSet/cfg.yaml  默认值（随插件提交）
 *   config/config/cfg.yaml  用户值（.gitignore 掉，首次加载从 defSet 复制生成）
 */
export const PLUGIN_DIR = "./plugins/QQBot-Plugin"
const DEF_FILE = `${PLUGIN_DIR}/config/defSet/cfg.yaml`
/** 用户配置文件路径：日志与提示里都用它，避免各处写死字符串 */
export const CFG_FILE = `${PLUGIN_DIR}/config/config/cfg.yaml`

/** 生效配置（活对象）：读的是它，指令改的也是它，改完调用 configSave() 落盘 */
export const config = {}

function readYaml(file) {
  try {
    return YAML.parse(fs.readFileSync(file, "utf8")) ?? {}
  } catch (err) {
    return null
  }
}

function writeConfig() {
  try {
    fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
    fs.writeFileSync(CFG_FILE, YAML.stringify(config))
  } catch (err) {
    globalThis.logger?.error?.("[QQBot-Plugin] 配置写入失败", err)
  }
}

/** 落盘（防抖，避免指令连续改配置时反复写文件） */
export const configSave = _.debounce(writeConfig, 3000)

fs.mkdirSync(path.dirname(CFG_FILE), { recursive: true })
/** 首次加载没有用户配置就从默认值复制一份（带注释），之后只读用户的这份 */
if (!fs.existsSync(CFG_FILE)) fs.copyFileSync(DEF_FILE, CFG_FILE)

const defSet = readYaml(DEF_FILE) ?? {}
_.merge(config, defSet, readYaml(CFG_FILE) ?? {})

/** 配置热更新：文件被外部改动时合并进 config（保留 miao makeConfig 原来的行为） */
chokidar.watch(CFG_FILE).on(
  "change",
  _.debounce(() => {
    const data = readYaml(CFG_FILE)
    if (data) _.merge(config, data)
  }, 3000),
)

/** napcat-adapter 风格的读取函数，返回同一个活对象 */
export default function cfg() {
  return config
}
