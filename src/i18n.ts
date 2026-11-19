import { getLanguage } from 'obsidian';

const en = {
  command_export: 'Export current note',
  menu_export: 'Export to PowerPoint',
  ribbon_export: 'Export note to PowerPoint',
  exporting: 'Building the PowerPoint file…',
  done: 'Saved {path} ({slides} slides).',
  done_one: 'Saved {path} (1 slide).',
  missing_images: '{count} image(s) could not be embedded: {names}',
  not_markdown: 'Open a Markdown note to export it.',
  empty: 'This note has no content to export.',
  failed: 'Export failed: {message}',
  locked: 'Could not write {path}. Close it in PowerPoint and try again.',
  exists_title: 'Replace the existing file?',
  exists_body:
    '{path} was changed since the last export, or was not made by this plugin. Replacing it discards those changes.',
  exists_replace: 'Replace',
  exists_keep: 'Keep both',
  exists_cancel: 'Cancel',
  split_name: 'New slide at',
  split_desc:
    'Automatic starts a slide at each heading and divides sections that are too long. A note that uses --- separators is split there instead.',
  split_auto: 'Automatic',
  split_rule: 'Horizontal rules (---)',
  split_h1: 'Heading 1',
  split_h2: 'Heading 1 and 2',
  split_h3: 'Heading 1 to 3',
  title_slide_name: 'Title slide',
  title_slide_desc: 'Start the deck with a slide that shows the note title.',
  ratio_name: 'Slide size',
  ratio_wide: 'Widescreen (16:9)',
  ratio_standard: 'Standard (4:3)',
  theme_name: 'Theme',
  theme_light: 'Light',
  theme_paper: 'Paper',
  theme_dark: 'Dark',
  theme_violet: 'Violet',
  font_name: 'Font',
  font_desc:
    'Must be installed on the computer that opens the file. Fonts are not embedded.',
  mono_font_name: 'Code font',
  numbers_name: 'Slide numbers',
  folder_name: 'Save to',
  folder_desc:
    'Vault folder for exported files. Leave empty to save next to the note.',
  folder_placeholder: 'Same folder as the note',
  open_name: 'Open after export',
  open_desc: 'Open the file in your presentation app.',
  about_name: 'About',
  about:
    'Slides are built on this device from the text of your note. Nothing is uploaded.',
  about_link: 'Need designed slides? EditablePPT can design them with AI.',
};

const zh: typeof en = {
  command_export: '导出当前笔记',
  menu_export: '导出为 PowerPoint',
  ribbon_export: '将笔记导出为 PowerPoint',
  exporting: '正在生成 PowerPoint 文件…',
  done: '已保存 {path}（{slides} 页）。',
  done_one: '已保存 {path}（1 页）。',
  missing_images: '有 {count} 张图片无法嵌入：{names}',
  not_markdown: '请先打开一篇 Markdown 笔记。',
  empty: '这篇笔记没有可导出的内容。',
  failed: '导出失败：{message}',
  locked: '无法写入 {path}。请先在 PowerPoint 中关闭它再试。',
  exists_title: '要替换已有文件吗？',
  exists_body:
    '{path} 在上次导出后被修改过，或者不是由本插件生成的。替换后这些修改会丢失。',
  exists_replace: '替换',
  exists_keep: '保留两者',
  exists_cancel: '取消',
  split_name: '分页方式',
  split_desc:
    '“自动”会在每个标题处新建一页，并拆分过长的章节。如果笔记使用 --- 分隔，则按分隔线分页。',
  split_auto: '自动',
  split_rule: '分隔线（---）',
  split_h1: '一级标题',
  split_h2: '一、二级标题',
  split_h3: '一至三级标题',
  title_slide_name: '标题页',
  title_slide_desc: '在开头添加一页，显示笔记标题。',
  ratio_name: '幻灯片大小',
  ratio_wide: '宽屏（16:9）',
  ratio_standard: '标准（4:3）',
  theme_name: '主题',
  theme_light: '浅色',
  theme_paper: '纸张',
  theme_dark: '深色',
  theme_violet: '紫色',
  font_name: '字体',
  font_desc: '打开文件的电脑上需要安装该字体，字体不会嵌入文件。',
  mono_font_name: '代码字体',
  numbers_name: '页码',
  folder_name: '保存位置',
  folder_desc: '导出文件所在的库内文件夹。留空则保存在笔记旁边。',
  folder_placeholder: '与笔记相同的文件夹',
  open_name: '导出后打开',
  open_desc: '用演示文稿应用打开导出的文件。',
  about_name: '关于',
  about: '幻灯片在本机根据笔记文字生成，不会上传任何内容。',
  about_link: '需要有设计感的幻灯片？EditablePPT 可以用 AI 设计。',
};

export type MessageKey = keyof typeof en;

export function t(key: MessageKey, values: Record<string, string | number> = {}) {
  const table = getLanguage().toLowerCase().startsWith('zh') ? zh : en;
  return table[key].replace(/\{(\w+)\}/g, (_all, name: string) =>
    String(values[name] ?? '')
  );
}
