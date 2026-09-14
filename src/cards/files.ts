import type { FileDeliverySnapshot, FileDeliveryEntry, GroupFileDeliverySettings } from '../file-delivery-types'
import { ELEMENTS } from './elements'

export const FILE_DELIVERY_CARD_ROWS = 12

export function fileSizeLabel(bytes: number | undefined): string {
  if (bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function escapeText(text: string): string {
  return text.replace(/[&<>\[\]()*_`!\\#|~]/g, char => `&#${char.charCodeAt(0)};`).replace(/[\r\n]+/g, ' ')
}

function linkUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('文件链接无效')
  return parsed.href.replace(/[()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function icon(name: string): string {
  const extension = name.split('.').at(-1)?.toLowerCase()
  if (['mp4', 'mov', 'mkv', 'webm'].includes(extension ?? '')) return '🎬'
  if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(extension ?? '')) return '🖼️'
  if (['zip', '7z', 'tar', 'gz'].includes(extension ?? '')) return '📦'
  if (['xlsx', 'xls', 'csv'].includes(extension ?? '')) return '📊'
  return '📄'
}

function fileRow(file: FileDeliveryEntry): object {
  const name = escapeText(file.name)
  const title = file.status === 'ready' && file.file?.url ? `[${name}](${linkUrl(file.file.url)})` : name
  const description = file.status === 'failed'
    ? `<font color='red'>${escapeText(file.error ?? '交付失败')}</font>`
    : `<font color='grey'>${fileSizeLabel(file.bytes)}${file.status === 'pending' ? ' · 上传中' : ''}</font>`
  return {
    tag: 'column_set', flex_mode: 'none', horizontal_spacing: '12px',
    columns: [
      { tag: 'column', width: '32px', vertical_align: 'center', elements: [{ tag: 'markdown', content: icon(file.name) }] },
      { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [{ tag: 'markdown', content: `${title}\n${description}` }] },
    ],
  }
}

/** An immutable delivery receipt. Native Drive owns the live file list and management UI. */
export function fileDeliveryCard(snapshot: FileDeliverySnapshot): object {
  const ready = snapshot.files.filter(file => file.status === 'ready').length
  const failed = snapshot.files.filter(file => file.status === 'failed').length
  const summary = `${ready} 个文件${failed ? ` · ${failed} 个未完成` : ''}`
  const folderUrl = snapshot.folderAccessReady && snapshot.folder ? linkUrl(snapshot.folder.url) : undefined
  const ordered = [...snapshot.files.filter(file => file.status === 'failed'), ...snapshot.files.filter(file => file.status !== 'failed')]
  const visible = ordered.slice(0, FILE_DELIVERY_CARD_ROWS)
  const hiddenFailures = ordered.slice(visible.length).filter(file => file.status === 'failed').length
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: `交付文件 · ${summary}` } },
    header: {
      title: { tag: 'plain_text', content: '📁 交付文件' },
      subtitle: { tag: 'plain_text', content: `${snapshot.projectName} · ${new Date(snapshot.createdAt).toLocaleString('zh-CN', { hour12: false })}` },
      template: ready || !failed ? 'blue' : 'red',
    },
    body: { padding: '16px', vertical_spacing: '16px', elements: [
      { tag: 'markdown', content: `**本次交付 · ${summary}**` },
      {
        tag: 'column_set', element_id: ELEMENTS.fileDeliveryList, flex_mode: 'none', background_style: 'grey-50',
        columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '12px', vertical_spacing: '12px', elements: [
          ...visible.map(fileRow),
          ...(snapshot.files.length > visible.length ? [{ tag: 'markdown', content: `<font color='grey'>其余 ${snapshot.files.length - visible.length} 个文件${hiddenFailures ? `中有 ${hiddenFailures} 个未完成，原因已单独提示；已上传文件` : ''}请打开文件夹查看</font>` }] : []),
        ] }],
      },
      ...(snapshot.error ? [{ tag: 'markdown', content: `<font color='red'>${escapeText(snapshot.error)}</font>` }] : []),
      ...(folderUrl ? [
        { tag: 'button', text: { tag: 'plain_text', content: '管理群文件' }, type: 'primary_filled', width: 'fill', behaviors: [{ type: 'open_url', default_url: folderUrl }] },
        { tag: 'markdown', content: '<font color=\'grey\'>卡片仅列本轮文件；管理入口查看本群全部云空间交付文件，可重命名、移动或删除。</font>', text_size: 'notation' },
      ] : []),
    ] },
  }
}

export function fileDeliverySettingsCard(opts: {
  groupName: string
  settings?: GroupFileDeliverySettings
  notice?: string
  error?: string
}): object {
  const mode = !opts.settings ? 'MISS' : opts.settings.enabled ? '云空间交付' : '聊天附件（默认）'
  return {
    schema: '2.0', config: { update_multi: true },
    header: { title: { tag: 'plain_text', content: 'files · 群文件交付' }, template: opts.error ? 'red' : 'blue' },
    body: { elements: [
      { tag: 'markdown', content: `**当前模式：${mode}**\n群：${escapeText(opts.settings?.folder?.name ?? opts.groupName)}` },
      ...(opts.notice ? [{ tag: 'markdown', content: escapeText(opts.notice) }] : []),
      ...(opts.error ? [{ tag: 'markdown', content: `<font color='red'>${escapeText(opts.error)}</font>` }] : []),
      {
        tag: 'column_set', background_style: 'grey-50',
        columns: [{ tag: 'column', width: 'weighted', weight: 1, padding: '12px', elements: [{
          tag: 'markdown', content: '`files on` 开启本群云空间交付\n`files off` 恢复直接发送聊天附件\n`files` 查看本群设置',
        }] }],
      },
      ...(opts.settings?.folder ? [{
        tag: 'button', text: { tag: 'plain_text', content: '管理群文件' }, type: 'primary_filled', width: 'fill',
        behaviors: [{ type: 'open_url', default_url: linkUrl(opts.settings.folder.url) }],
      }] : []),
    ] },
  }
}
