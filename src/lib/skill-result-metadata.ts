/** UI-only metadata, including an unfinished comment while streaming. */
export function stripSkillResultMetadata(content: string): string {
  return content.replace(/<!-- jean-skill-result:[\s\S]*?(?:-->|$)/g, '')
}
