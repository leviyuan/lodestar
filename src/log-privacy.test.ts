import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
import ts from 'typescript'

// Event labels must be compile-time text. Error bodies and operational fields
// go through the separate allowlisted formatter; identifiers must never be
// interpolated into a label, even if they are shortened or hashed.
function literalType(type: ts.TypeNode | undefined): boolean {
  return !!type && (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)
    || ts.isUnionTypeNode(type) && type.types.every(literalType))
}

function fixedEvent(node: ts.Expression | undefined): boolean {
  if (!node) return false
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return true
  if (ts.isConditionalExpression(node)) return fixedEvent(node.whenTrue) && fixedEvent(node.whenFalse)
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
    && ['formatLogError', 'formatLogDiagnostic'].includes(node.expression.text)) return fixedEvent(node.arguments[0])
  if (ts.isIdentifier(node)) {
    for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
      if (!ts.isMethodDeclaration(parent) && !ts.isFunctionDeclaration(parent) && !ts.isArrowFunction(parent)) continue
      const parameter = parent.parameters.find(parameter => ts.isIdentifier(parameter.name) && parameter.name.text === node.text)
      if (parameter) return literalType(parameter.type)
    }
  }
  return false
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [path] : []
  })
}

test('runtime log events cannot interpolate owners, identifiers, paths, payloads or counts', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const violations: string[] = []
  for (const file of [...sourceFiles(join(root, 'src')), join(root, 'daemon.ts'), join(root, 'cli.ts')]) {
    if (file === join(root, 'src/log.ts')) continue // Sanitized formatter implementation, tested at both sinks.
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = node.expression
        const name = ts.isIdentifier(target) ? target.text : ts.isPropertyAccessExpression(target) ? target.name.text : ''
        const consoleCall = ts.isPropertyAccessExpression(target) && target.expression.getText(source) === 'console'
        if (!consoleCall && ['log', 'logError', 'logDiagnostic', 'formatLogError', 'formatLogDiagnostic'].includes(name)
          && !fixedEvent(node.arguments[0])) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
          violations.push(`${relative(root, file)}:${line}`)
        }
      }
      if (ts.isNewExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && node.expression.expression.getText(source) === 'lark'
        && ['Client', 'WSClient', 'EventDispatcher'].includes(node.expression.name.text)) {
        const options = node.arguments?.[0]
        if (!options || !ts.isObjectLiteralExpression(options)
          || !options.properties.some(property => property.name?.getText(source) === 'logger')) {
          violations.push(`${relative(root, file)}: SDK logger missing`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  expect(violations).toEqual([])
})

test('source startup catches import failures before the runtime can print private configuration paths', () => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const daemon = ts.createSourceFile('daemon.ts', readFileSync(join(root, 'daemon.ts'), 'utf8'), ts.ScriptTarget.Latest)
  const firstImport = daemon.statements.find(ts.isImportDeclaration)!
  expect((firstImport.moduleSpecifier as ts.StringLiteral).text).toBe('./src/daemon-startup-logging')
  const handoff = daemon.statements.findIndex(statement => ts.isExpressionStatement(statement)
    && ts.isCallExpression(statement.expression) && ts.isIdentifier(statement.expression.expression)
    && statement.expression.expression.text === 'finishStartupLogging')
  const lastInitialization = daemon.statements.reduce((last, statement, index) => ts.isVariableStatement(statement) ? index : last, -1)
  expect(handoff).toBeGreaterThan(lastInitialization)
  const directory = mkdtempSync(join(tmpdir(), 'lodestar-startup-privacy-'))
  try {
    const script = join(directory, 'startup.ts')
    // Import only the guard and failing config, never the daemon or any Agent.
    writeFileSync(script, `
      import ${JSON.stringify(join(root, 'src/daemon-startup-logging.ts'))};
      import ${JSON.stringify(join(root, 'src/config.ts'))};
    `)
    const result = Bun.spawnSync([process.execPath, script], {
      env: { ...process.env, NODE_ENV: 'test', LODESTAR_DATA_DIR: directory,
        LODESTAR_CONFIG: join(directory, 'private-owner-missing.toml') },
      stdout: 'pipe', stderr: 'pipe',
    })
    expect(result.exitCode).toBe(1)
    const stderr = result.stderr.toString()
    expect(stderr).toContain('daemon: startup failed reason=ENOENT')
    expect(stderr).not.toContain(directory)
    expect(stderr).not.toContain(root)
    expect(stderr).not.toContain('private-owner')
    expect(result.stdout.toString()).toBe('')
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
