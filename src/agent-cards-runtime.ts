import { AgentCards, type AgentCardsDeps } from './agent-cards'
import * as cardkit from './cardkit'
import * as feishu from './feishu'

export const agentCardsDeps: AgentCardsDeps = {
  sendCard: feishu.sendCard,
  getChatTailMessageId: feishu.getChatTailMessageId,
  convertMessageToCard: cardkit.convertMessageToCard,
  recordCardCreated: cardkit.recordCardCreated,
  getElementCount: cardkit.getElementCount,
  addElementResult: cardkit.addElementResult,
  replaceElementResult: cardkit.replaceElementResult,
  deleteElementChecked: cardkit.deleteElementChecked,
  cancelSummary: cardkit.cancelSummary,
  patchSettingsChecked: cardkit.patchSettingsChecked,
  dispose: cardkit.dispose,
}

export function createAgentCards(): AgentCards {
  return new AgentCards(agentCardsDeps)
}
