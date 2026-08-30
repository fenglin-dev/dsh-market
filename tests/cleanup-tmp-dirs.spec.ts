import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanupTmpDirsInNodeModules } from '../src/dsh-cli.ts'

describe('cleanupTmpDirsInNodeModules (pnpm stale temp dirs before install)', () => {
  let profileDir: string

  afterEach(() => {
    if (profileDir) rmSync(profileDir, { recursive: true, force: true })
  })

  const makeProfile = (): string => {
    profileDir = mkdtempSync(join(tmpdir(), 'dsh-profile-'))
    return profileDir
  }

  it('does nothing when node_modules/.pnpm does not exist', () => {
    const dir = makeProfile()
    // Should not throw
    expect(() => cleanupTmpDirsInNodeModules(dir)).not.toThrow()
  })

  it('removes a stale temp dir matching pnpm fastPathTemp shape under .pnpm', () => {
    const dir = makeProfile()
    const tmpDir = join(dir, 'node_modules', '.pnpm', 'node-hid@3.4.0', 'node_modules', 'node-hid_tmp_99999_1')
    require('node:fs').mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'stale.txt'), 'stale')

    cleanupTmpDirsInNodeModules(dir)

    expect(require('node:fs').existsSync(tmpDir)).toBe(false)
  })

  it('leaves ordinary directories alone, even if their name contains _tmp_', () => {
    const dir = makeProfile()
    // A real package whose name happens to contain "_tmp_" is not pnpm's
    // fastPathTemp shape (which requires _tmp_<pid>_<n> at the END).
    const realDir = join(dir, 'node_modules', '.pnpm', 'some_tmp_package@1.0.0', 'node_modules', 'some_tmp_package')
    require('node:fs').mkdirSync(realDir, { recursive: true })
    writeFileSync(join(realDir, 'package.json'), '{}')

    cleanupTmpDirsInNodeModules(dir)

    expect(require('node:fs').existsSync(realDir)).toBe(true)
  })

  it('does not remove a temp dir whose pid still belongs to a live process', () => {
    const dir = makeProfile()
    const ownPid = process.pid
    const tmpDir = join(dir, 'node_modules', '.pnpm', 'node-hid@3.4.0', 'node_modules', `node-hid_tmp_${ownPid}_1`)
    require('node:fs').mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, 'live.txt'), 'live')

    cleanupTmpDirsInNodeModules(dir)

    // Own pid is alive, so the dir must survive.
    expect(require('node:fs').existsSync(tmpDir)).toBe(true)
  })

  it('removes temp dirs at any depth under .pnpm (not just top-level node_modules)', () => {
    const dir = makeProfile()
    // pnpm's virtual store nests packages three levels deep:
    //   .pnpm/<pkg>@<ver>/node_modules/<name>
    // and fastPathTemp places the temp dir as a sibling of <name>.
    const deepTmp = join(dir, 'node_modules', '.pnpm', '@scope+pkg@1.2.3', 'node_modules', 'pkg_tmp_88888_2')
    require('node:fs').mkdirSync(deepTmp, { recursive: true })
    writeFileSync(join(deepTmp, 'deep.txt'), 'deep')

    cleanupTmpDirsInNodeModules(dir)

    expect(require('node:fs').existsSync(deepTmp)).toBe(false)
  })

  it('logs a warning but does not crash when rmSync throws on a stale dir', () => {
    const dir = makeProfile()
    const tmpDir = join(dir, 'node_modules', '.pnpm', 'node-hid@3.4.0', 'node_modules', 'node-hid_tmp_77777_1')
    require('node:fs').mkdirSync(tmpDir, { recursive: true })

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // Mock rmSync to throw only for this specific path
    const originalRmSync = require('node:fs').rmSync
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs')
      return {
        ...actual,
        rmSync: (path: string, opts: unknown) => {
          if (path === tmpDir) throw new Error('EBUSY: resource busy or locked')
          return originalRmSync(path, opts)
        },
      }
    })

    // Re-import to pick up the mock
    return import('../src/dsh-cli.ts').then(({ cleanupTmpDirsInNodeModules: cleanup }) => {
      expect(() => cleanup(dir)).not.toThrow()
      // The dir should still exist because rmSync threw
      expect(require('node:fs').existsSync(tmpDir)).toBe(true)
      warnSpy.mockRestore()
      vi.doUnmock('node:fs')
    })
  })

  it('does nothing when .pnpm exists but has no temp dirs', () => {
    const dir = makeProfile()
    const normalDir = join(dir, 'node_modules', '.pnpm', 'normal-pkg@1.0.0', 'node_modules', 'normal-pkg')
    require('node:fs').mkdirSync(normalDir, { recursive: true })
    writeFileSync(join(normalDir, 'package.json'), '{}')

    cleanupTmpDirsInNodeModules(dir)

    expect(require('node:fs').existsSync(normalDir)).toBe(true)
  })

  it('matches the exact pnpm fastPathTemp pattern: <name>_tmp_<pid>_<threadId>', () => {
    const dir = makeProfile()
    // Valid shape
    const valid = join(dir, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg_tmp_12345_3')
    require('node:fs').mkdirSync(valid, { recursive: true })
    // Invalid shapes (must survive)
    const noPid = join(dir, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg_tmp__1')
    require('node:fs').mkdirSync(noPid, { recursive: true })
    const noThread = join(dir, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'pkg_tmp_12345_')
    require('node:fs').mkdirSync(noThread, { recursive: true })
    const wrongOrder = join(dir, 'node_modules', '.pnpm', 'pkg@1.0.0', 'node_modules', 'tmp_12345_1_pkg')
    require('node:fs').mkdirSync(wrongOrder, { recursive: true })

    cleanupTmpDirsInNodeModules(dir)

    expect(require('node:fs').existsSync(valid)).toBe(false)
    expect(require('node:fs').existsSync(noPid)).toBe(true)
    expect(require('node:fs').existsSync(noThread)).toBe(true)
    expect(require('node:fs').existsSync(wrongOrder)).toBe(true)
  })
})
