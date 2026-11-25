/**
 * The toolchain the sandbox image carries, one place for the Docker image and the E2B template, which are
 * both built from ops/sandbox/Dockerfile. sandbox-toolchain.test.ts fails when the Dockerfile names others.
 */
export const SANDBOX_TOOLCHAIN = {
  node: '22.23.5',
  pnpm: '12.8.1',
  /** The headers are the ones of the image's own Node, in this directory, so node-gyp downloads nothing. */
  nodeHeaders: '22.23.5',
  nodeHeadersDir: '/usr/local',
}

/**
 * The word lists theokit's `theocode` english-only check (apps/theocode/tools/english-only-detectors.mjs) reads: its
 * verdict depends on which of these paths the image holds. The image installs the same two packages as theokit's CI
 * runner (`wamerican wbrazilian`), which provide the paths in SANDBOX_DICTIONARY_PRESENT; the rest must be absent.
 */
export const CHECKER_DICTIONARY_PATHS = [
  '/usr/share/dict/american-english',
  '/usr/share/dict/words',
  '/usr/share/hunspell/en_US.dic',
  '/usr/share/dict/brazilian',
  '/usr/share/dict/portuguese',
  '/usr/share/hunspell/pt_BR.dic',
]
export const SANDBOX_DICTIONARY_PACKAGES = ['wamerican', 'wbrazilian']
export const SANDBOX_DICTIONARY_PRESENT = [
  '/usr/share/dict/american-english',
  '/usr/share/dict/words',
  '/usr/share/dict/brazilian',
]
