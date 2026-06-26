/**
 * Whether a drag event carries OS files (as opposed to internal element drags
 * used for list/tree reordering). `DataTransfer.types` is already a string
 * array, so no `Array.from` is needed — these fire on every dragover.
 */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  return (dataTransfer?.types ?? []).includes('Files')
}
