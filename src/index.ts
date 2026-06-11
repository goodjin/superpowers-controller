import type { PluginModule } from "@opencode-ai/plugin"
import { createPluginModule } from "./plugin"

const pluginModule: PluginModule = createPluginModule()

export default pluginModule
export { createPluginModule }
