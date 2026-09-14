import { syncManagedSkill } from './managed-skills'
import { FILE_DELIVERY_SKILL_NAME, fileDeliverySkillBody } from './instructions'

/** The same small handoff Skill is shipped to standalone agents and the managed SDK/DSH plugin. */
export function ensureLodestarFileSkill(roots?: string[]): void {
  syncManagedSkill({ name: FILE_DELIVERY_SKILL_NAME, body: fileDeliverySkillBody() }, roots)
}
