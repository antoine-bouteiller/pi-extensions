const PI_IDENTITY_LINE = /^You are an expert coding assistant operating inside pi, a coding agent harness\.[^\n]*\n+/
const PI_DOCS_BLOCK = /(?<=\n)Pi documentation \(read only when[\s\S]*?(?=\n\n|\nCurrent date:|\nCurrent working directory:|$)/
const DUPLICATE_ENV_PREAMBLE_BLOCK = /\nHere is some useful information about the environment you are running in:\n<env>[\s\S]*?<\/env>\n/

const GENERIC_IDENTITY =
  'You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.\n'

export const scrubPiFingerprints = (systemPrompt: string): string => {
  if (systemPrompt.length === 0) {
    return systemPrompt
  }

  const hasPiIdentity = PI_IDENTITY_LINE.test(systemPrompt)
  const withoutIdentity = systemPrompt.replace(PI_IDENTITY_LINE, GENERIC_IDENTITY)
  const withoutDocs = hasPiIdentity ? withoutIdentity.replace(PI_DOCS_BLOCK, '') : withoutIdentity
  const scrubbed = withoutDocs.replace(DUPLICATE_ENV_PREAMBLE_BLOCK, '\n')

  return scrubbed === systemPrompt ? systemPrompt : scrubbed.replaceAll(/\n{3,}/g, '\n\n').replace(/\s+$/, '')
}
