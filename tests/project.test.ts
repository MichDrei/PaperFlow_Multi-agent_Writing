/**
 * 项目文件存储测试。
 *
 * 这一层管的是"Overleaf 式项目管理"的正确性与安全性：
 * - 路径穿越（`../`）必须被挡住——这是唯一能把文件写到项目目录之外的地方；
 * - 导入 Overleaf 导出的 zip 时要剥掉顶层目录、跳过 macOS 垃圾文件；
 * - 二进制资源（图片 / .pdf）必须原样落盘，不能当文本写坏。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import JSZip from 'jszip';

import {
  isJunkFile,
  texBasenames,
  ProjectStore,
  kindForPath,
  normalizeProjectPath,
} from '../apps/server/src/storage/projectStore.js';
import { ProjectRegistry } from '../apps/server/src/storage/projectRegistry.js';

function withStore(): { store: ProjectStore; cleanup: () => void } {
  const dir = mkdtempSync(join(process.cwd(), '.cache', 'project-test-'));
  return {
    store: new ProjectStore({ root: dir }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('路径规范化：挡住跳出项目目录的各种写法', () => {
  assert.equal(normalizeProjectPath('main.tex'), 'main.tex');
  assert.equal(normalizeProjectPath('sections/intro.tex'), 'sections/intro.tex');
  assert.equal(normalizeProjectPath('/leading/slash.tex'), 'leading/slash.tex');
  assert.equal(normalizeProjectPath('a//b.tex'), 'a/b.tex');

  // 这些都必须抛错——否则能把文件写到项目之外
  for (const evil of ['../escape.tex', 'a/../../escape.tex', '..', 'a/..', '']) {
    assert.throws(() => normalizeProjectPath(evil), /非法路径|不能为空/, `应拒绝：${evil}`);
  }
});

test('文件类型判定：.cls/.sty 归为 style，图片归为 image', () => {
  assert.equal(kindForPath('main.tex'), 'tex');
  assert.equal(kindForPath('ref.bib'), 'bib');
  assert.equal(kindForPath('IEEEtran.cls'), 'style');
  assert.equal(kindForPath('figures/plot.png'), 'image');
  assert.equal(kindForPath('figures/plot.pdf'), 'image');
  assert.equal(kindForPath('notes.txt'), 'other');
});

test('读写与清单：目录由路径推导，二进制按 base64 原样存取', () => {
  const { store, cleanup } = withStore();
  try {
    store.ensure('p1');
    store.write('p1', 'root.tex', '\\documentclass{article}');
    store.write('p1', 'sections/intro.tex', '\\section{Intro}');
    store.createFolder('p1', 'figures');
    // 再建一个**空**目录：空目录不会由文件路径推导出来，必须显式出现在清单里，
    // 否则用户建完文件夹会发现它"不见了"。
    store.createFolder('p1', 'empty-dir');

    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    store.write('p1', 'figures/x.png', binary.toString('base64'), 'base64');

    const manifest = store.manifest('p1');
    assert.deepEqual(
      manifest.files.filter((f) => !f.isDirectory).map((f) => f.path),
      ['figures/x.png', 'root.tex', 'sections/intro.tex'],
    );
    assert.ok(manifest.files.some((f) => f.isDirectory && f.path === 'empty-dir'), '空目录必须出现在清单里');
    assert.ok(!manifest.files.some((f) => f.isDirectory && f.path === 'figures'), '有内容的目录由子项路径推导，不重复列出');
    assert.equal(manifest.rootPath, 'root.tex');

    // 二进制读回来必须逐字节一致（当文本写会得到乱码/损坏）
    const read = store.read('p1', 'figures/x.png');
    assert.equal(read.encoding, 'base64');
    assert.deepEqual(Buffer.from(read.content, 'base64'), binary);

    // 重命名要能跨目录移动
    store.rename('p1', 'sections/intro.tex', 'sections/01-intro.tex');
    assert.ok(store.manifest('p1').files.some((f) => f.path === 'sections/01-intro.tex'));

    store.remove('p1', 'sections');
    assert.ok(!store.manifest('p1').files.some((f) => f.path.startsWith('sections/')));
  } finally {
    cleanup();
  }
});

test('导入 Overleaf 导出的 zip：剥掉顶层目录、跳过 __MACOSX 垃圾、保留二进制', async () => {
  const { store, cleanup } = withStore();
  try {
    const zip = new JSZip();
    const root = zip.folder('my-paper-1.2')!;
    root.file('root.tex', '\\documentclass{article}\\begin{document}hi\\end{document}');
    root.file('sections/intro.tex', '\\section{Intro}');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    root.file('figures/plot.png', png);
    zip.file('__MACOSX/._root.tex', 'junk');
    root.file('.DS_Store', 'junk');

    const result = await store.importZip('p1', (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64'), {
      replace: true,
    });

    assert.equal(result.imported, 3, '只应导入 3 个真实文件');
    assert.ok(result.skipped.length >= 2, '垃圾文件应被跳过');
    assert.equal(result.rootPath, 'root.tex', '顶层目录必须被剥掉，否则 \\input 的相对路径会失效');

    const manifest = store.manifest('p1');
    assert.deepEqual(
      manifest.files.filter((f) => !f.isDirectory).map((f) => f.path).sort(),
      ['figures/plot.png', 'root.tex', 'sections/intro.tex'],
    );
    // 二进制内容必须完好
    const restored = Buffer.from(store.read('p1', 'figures/plot.png').content, 'base64');
    assert.deepEqual(restored, png);

    // 导出再导入应当幂等（对应 Overleaf 的 Download Source）
    const exported = await store.exportZip('p1');
    store.ensure('p2');
    await store.importZip('p2', exported.toString('base64'), { replace: true });
    assert.deepEqual(
      store.manifest('p2').files.filter((f) => !f.isDirectory).map((f) => f.path).sort(),
      manifest.files.filter((f) => !f.isDirectory).map((f) => f.path).sort(),
    );
  } finally {
    cleanup();
  }
});

test('readAll：交给编译器的文件集应包含全部非目录文件及其编码', () => {
  const { store, cleanup } = withStore();
  try {
    store.ensure('p1');
    store.write('p1', 'root.tex', 'A');
    store.write('p1', 'ref.bib', '@article{k, title={T}}');
    store.write('p1', 'fig.png', Buffer.from([1, 2, 3]).toString('base64'), 'base64');

    const all = store.readAll('p1');
    assert.equal(all.length, 3);
    assert.equal(all.find((f) => f.path === 'root.tex')?.encoding, 'utf8');
    assert.equal(all.find((f) => f.path === 'fig.png')?.encoding, 'base64');
  } finally {
    cleanup();
  }
});

test('项目目录落盘：文件真的写到了磁盘（而不是只存在内存里）', () => {
  const { store, cleanup } = withStore();
  try {
    store.ensure('p1');
    store.write('p1', 'nested/deep/file.tex', 'content');
    const onDisk = readFileSync(join(store.projectDir('p1'), 'nested/deep/file.tex'), 'utf8');
    assert.equal(onDisk, 'content');
  } finally {
    cleanup();
  }
});

test('多项目：注册表支持新建/重命名/删除，且各项目目录互不可见', () => {
  const dir = mkdtempSync(join(process.cwd(), '.cache', 'registry-test-'));
  try {
    const registry = new ProjectRegistry({ paperflowRoot: dir });
    const store = new ProjectStore({ root: join(dir, 'projects') });

    const icra = registry.create('ICRA 2026');
    const ral = registry.create('RAL journal');
    assert.notEqual(icra.id, ral.id);

    store.ensure(icra.id, { 'main.tex': 'ICRA content' });
    store.ensure(ral.id, { 'main.tex': 'RAL content' });

    // 同名再建不能覆盖已有项目
    const again = registry.create('ICRA 2026');
    assert.notEqual(again.id, icra.id, '重名项目应生成不同 id');

    // 文件互不可见
    assert.equal(store.read(icra.id, 'main.tex').content, 'ICRA content');
    assert.equal(store.read(ral.id, 'main.tex').content, 'RAL content');
    assert.throws(() => store.read(ral.id, 'nonexistent.tex'));

    // 删除项目要连文件一起清掉
    assert.equal(registry.remove(icra.id), true);
    assert.equal(registry.get(icra.id), undefined);
    assert.equal(existsSync(store.projectDir(icra.id)), false);

    // 建了 3 个（icra / ral / again），删掉 icra 后应剩 2 个
    assert.equal(registry.list().length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('主文档记录持久化：切项目后仍记得各自的主文档', () => {
  const { store, cleanup } = withStore();
  try {
    store.ensure('p1', { 'main.tex': 'a', 'root.tex': 'b' });
    store.setRootPath('p1', 'root.tex');
    assert.equal(store.manifest('p1').rootPath, 'root.tex', '应记住用户指定的主文档');
    // 记录文件本身不应出现在清单里（点开头的文件会被跳过）
    assert.ok(!store.manifest('p1').files.some((f) => f.path.includes('paperflow-root')));
  } finally {
    cleanup();
  }
});

test('导入体积与原始字节：大 zip 走二进制通道，超限时给出可读的错误', async () => {
  const { store, cleanup } = withStore();
  try {
    // 原始字节写入（图片等）不应经过 base64——base64 会膨胀 33% 并撞上 body 上限
    const big = Buffer.alloc(3 * 1024 * 1024, 7);
    const entry = store.writeRaw('p1', 'figures/big.png', big);
    assert.equal(entry.size, big.byteLength);
    assert.equal(entry.encoding, 'base64');
    assert.deepEqual(Buffer.from(store.read('p1', 'figures/big.png').content, 'base64'), big);

    // 超过单文件上限时必须**明确报出大小与上限**，而不是静默失败
    assert.throws(
      () => store.writeRaw('p1', 'too-big.bin', Buffer.alloc(65 * 1024 * 1024)),
      /超过上限/,
    );

    // 导入一个真实的 zip（原始字节入口）
    const zip = new JSZip();
    zip.file('main.tex', '\\documentclass{article}');
    zip.file('figures/dot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = await store.importZipBuffer('p2', await zip.generateAsync({ type: 'nodebuffer' }), {
      replace: true,
    });
    assert.equal(result.imported, 2);
    assert.equal(result.rootPath, 'main.tex');
  } finally {
    cleanup();
  }
});

test('主文档智能识别：优先"能独立编译的完整文档"，而不是字母序第一个 .tex', () => {
  const { store, cleanup } = withStore();
  try {
    // 真实翻车场景：项目里有一个片段式/无关的 main.tex，真正的主文档是 root.tex
    store.ensure('p1', {
      'main.tex': '% 只是个片段，没有 documentclass',
      'root.tex': '\\documentclass{ieeeconf}\n\\begin{document}\nhi\n\\end{document}',
      'sections/intro.tex': '\\section{Intro}',
    });

    const manifest = store.manifest('p1');
    assert.equal(
      manifest.rootPath,
      'root.tex',
      '含有 \\documentclass + \\begin{document} 的文档应优先；片段不该被当成主文档',
    );

    // 显式指定优先于任何推断
    store.setRootPath('p1', 'sections/intro.tex');
    assert.equal(store.manifest('p1').rootPath, 'sections/intro.tex');
  } finally {
    cleanup();
  }
});

test('主文档识别：同名候选时顶层且名字像主文档的优先', () => {
  const { store, cleanup } = withStore();
  try {
    const body = '\\documentclass{article}\n\\begin{document}\nx\n\\end{document}';
    store.ensure('p1', {
      'drafts/paper.tex': body,
      'root.tex': body,
      'main.tex': body,
    });
    // main.tex 与 root.tex 都是顶层完整文档：按名字加成并列，再按路径排序 → main.tex 胜出
    assert.equal(store.manifest('p1').rootPath, 'main.tex');
  } finally {
    cleanup();
  }
});

test('导入时跳过编译产物与视频，但保留插图 PDF', () => {
  // 实测一个毕设项目 815MB：编译产物 PDF 153MB + 4 个演示视频 196MB，
  // 这些既不能排版、还会让上传/导入直接超限。
  const texNames = texBasenames(['sztuthesis_main.tex', 'chapters/ch1.tex']);

  assert.equal(isJunkFile('sztuthesis_main.pdf', texNames), true, '与 .tex 同名的 PDF 是编译产物');
  assert.equal(isJunkFile('chapters/ch1.pdf', texNames), true, '子目录里同名的也算');
  assert.equal(isJunkFile('figures/fig-correlation.pdf', texNames), false, '插图的 PDF 必须保留');
  assert.equal(isJunkFile('images/触觉1.mp4', texNames), true, '视频不能用于排版');
  assert.equal(isJunkFile('content/abstracten.aux', texNames), true, 'aux 是中间文件');
  assert.equal(isJunkFile('sztuthesis_main.synctex.gz', texNames), true);
  assert.equal(isJunkFile('images/系统框图.png', texNames), false, '插图要保留');
  assert.equal(isJunkFile('SimSun.ttf', texNames), false, '字体要保留（模板靠它编译）');
});

test('texBasenames：识别编译产物时只看 .tex 的基名', () => {
  const names = texBasenames(['main.tex', 'chapters/intro.TEX', 'figures/plot.pdf']);
  assert.ok(names.has('main'));
  assert.ok(names.has('intro'), '大小写不敏感');
  assert.equal(names.size, 2);
});
