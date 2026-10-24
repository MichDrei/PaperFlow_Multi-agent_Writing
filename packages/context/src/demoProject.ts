/**
 * 演示项目固件（fixtures）。
 *
 * 作用：让 UI 雏形与编排层在任何 API Key、任何后端都没就绪时就有真实可读的数据，
 * 也让测试有稳定的输入。真实项目会从 storage 层加载同样形状的数据。
 */

import type { Citation, FigureAsset, PaperDocument, SharedContext, TerminologyEntry } from '@paperflow/core';

const MAIN_TEX = String.raw`\documentclass[11pt]{article}
\usepackage{amsmath,amssymb}
\usepackage{graphicx}
\usepackage{booktabs}
\usepackage{natbib}

\title{Speculative Decoding with Adaptive Draft Lengths for Long-Context Scientific Summarization}
\author{Wei Zhang \and Priya Raman \and Daniel Okafor}
\date{\today}

\begin{document}
\maketitle

\begin{abstract}
Long-context scientific summarization is bottlenecked by the autoregressive decoding cost of large
language models. We introduce Adaptive Speculative Decoding (ASD), which predicts a per-step draft
length from the entropy of the draft distribution and the recent acceptance rate. Unlike fixed-length
speculative decoding, ASD avoids wasted draft computation when the draft model is uncertain, and
aggressively speculates when the context is highly predictable. On three scientific summarization
benchmarks, ASD reduces wall-clock latency by 2.4x at identical output distributions, and improves
ROUGE-L by 1.7 points over a strong retrieval-augmented generation baseline. We further show that the
gain grows with context length, reaching 3.1x at 128K tokens.
\end{abstract}

\section{Introduction}
Scientific summarization requires condensing evidence scattered across dozens of pages while preserving
numeric fidelity. Large language models can produce fluent summaries, but the decoding cost scales
linearly with output length, and long inputs make every decoding step more expensive because attention
must traverse the entire context \citep{vaswani2017attention}.

Speculative decoding accelerates generation by letting a small draft model propose several tokens that a
large target model verifies in a single forward pass \citep{leviathan2023fast}. The standard formulation
uses a fixed draft length $K$. This is a poor fit for scientific text: passages of equations are nearly
deterministic and tolerate long drafts, whereas passages that paraphrase experimental results are
unpredictable and waste most of the draft budget.

We propose Adaptive Speculative Decoding (ASD). The draft length at step $t$ is chosen to maximize the
expected number of accepted tokens per unit of draft compute, estimated from the entropy of the draft
distribution and the exponentially weighted acceptance rate.

\section{Related Work}
Retrieval-augmented generation grounds summarization in source documents \citep{lewis2020rag}, but the
retriever is usually optimized independently of the decoder. Prior work on speculative decoding treats
the draft length as a hyperparameter \citep{chen2023accelerating}. Adaptive computation has been explored
for early exiting, yet not for the draft length in verification-based decoding.

\section{Method}
\subsection{Adaptive draft length}
Let $H_t$ denote the entropy of the draft model distribution at step $t$, and let $\bar{a}_t$ be the
exponentially weighted acceptance rate over the last $W$ verification rounds. We model the expected
accepted length as
\begin{equation}
  \mathbb{E}[A \mid K] = \sum_{k=1}^{K} \bar{a}_t^{\,k} \cdot \sigma(\alpha - \beta H_t),
\end{equation}
where $\sigma$ is the logistic function. We select $K_t^{*} = \arg\max_{K \le K_{\max}} \mathbb{E}[A \mid K] / K$.
The division by $K$ is what prevents the model from always choosing the largest draft.

\subsection{Verification with numeric guards}
Scientific summaries must not invent numbers. We add a numeric guard that rejects any proposed token span
whose digits cannot be aligned with a span in the retrieved context. Rejected spans fall back to the
target model, which is slower but grounded.

\section{Experiments}
We evaluate on arXiv, PubMed, and S2ORC summarization splits. All experiments use greedy decoding for the
target model. Latency is measured on a single A100 with batch size one.

\begin{table}[t]
\centering
\begin{tabular}{lccc}
\toprule
Method & ROUGE-L & Latency (s) & Speedup \\
\midrule
Baseline & 41.2 & 18.4 & 1.0x \\
Fixed $K=4$ & 41.4 & 9.1 & 2.0x \\
ASD (ours) & 42.9 & 7.6 & 2.4x \\
\bottomrule
\end{tabular}
\caption{Main results. ASD improves both quality and latency.}
\label{tab:main}
\end{table}

\section{Conclusion}
Adaptive draft lengths make speculative decoding practical for long-context scientific writing. Future
work will couple the draft policy with the retriever so that speculation focuses on grounded spans.

\bibliographystyle{plainnat}
\bibliography{refs}

\end{document}
`;

const METHOD_TEX = String.raw`\section{Method}

\subsection{Adaptive draft length}
Let $H_t$ denote the entropy of the draft model distribution at step $t$, and let $\bar{a}_t$ be the
exponentially weighted acceptance rate. We model the expected accepted length as
\begin{equation}
  \mathbb{E}[A \mid K] = \sum_{k=1}^{K} \bar{a}_t^{\,k} \cdot \sigma(\alpha - \beta H_t).
\end{equation}

We select $K_t^{*} = \arg\max_{K \le K_{\max}} \mathbb{E}[A \mid K] / K$. Dividing by $K$ prevents the
policy from collapsing to $K_{\max}$.

\subsection{Numeric guards}
Any token span whose digits cannot be aligned with the retrieved context is rejected and recomputed by
the target model.
`;

const REFS_BIB = String.raw`@inproceedings{vaswani2017attention,
  title = {Attention Is All You Need},
  author = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and Uszkoreit, Jakob},
  year = {2017},
  booktitle = {Advances in Neural Information Processing Systems},
  keywords = {transformer, attention}
}

@article{leviathan2023fast,
  title = {Fast Inference from Transformers via Speculative Decoding},
  author = {Leviathan, Yaniv and Kalman, Matan and Matias, Yossi},
  year = {2023},
  journal = {International Conference on Machine Learning},
  keywords = {speculative decoding, inference}
}

@inproceedings{lewis2020rag,
  title = {Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks},
  author = {Lewis, Patrick and Perez, Ethan and Piktus, Aleksandra and Petroni, Fabio},
  year = {2020},
  booktitle = {Advances in Neural Information Processing Systems},
  keywords = {retrieval, summarization}
}

@article{chen2023accelerating,
  title = {Accelerating Large Language Model Decoding with Speculative Sampling},
  author = {Chen, Charlie and Borgeaud, Sebastian and Irving, Geoffrey and Lespiau, Jean-Baptiste},
  year = {2023},
  journal = {arXiv preprint},
  keywords = {speculative decoding, sampling}
}

@article{zhang2024longcontext,
  title = {Long-Context Scientific Summarization: A Benchmark Study},
  author = {Zhang, Wei and Raman, Priya},
  year = {2024},
  journal = {Conference on Empirical Methods in Natural Language Processing},
  keywords = {summarization, benchmark}
}
`;

export const DEMO_DOCUMENT: PaperDocument = (() => {
  const files = {
    'file-main': { id: 'file-main', path: 'main.tex', kind: 'tex' as const, content: MAIN_TEX, version: 1 },
    'file-method': { id: 'file-method', path: 'sections/method.tex', kind: 'tex' as const, content: METHOD_TEX, version: 1 },
    'file-bib': { id: 'file-bib', path: 'refs.bib', kind: 'bib' as const, content: REFS_BIB, version: 1 },
  };
  return {
    id: 'doc-asd-2024',
    title: 'Speculative Decoding with Adaptive Draft Lengths',
    rootFileId: 'file-main',
    files,
    updatedAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
  };
})();

export const DEMO_CITATIONS: Citation[] = [
  {
    key: 'vaswani2017attention',
    type: 'inproceedings',
    title: 'Attention Is All You Need',
    authors: ['Vaswani, Ashish', 'Shazeer, Noam', 'Parmar, Niki'],
    year: 2017,
    venue: 'NeurIPS',
    tags: ['transformer', 'attention'],
  },
  {
    key: 'leviathan2023fast',
    type: 'article',
    title: 'Fast Inference from Transformers via Speculative Decoding',
    authors: ['Leviathan, Yaniv', 'Kalman, Matan', 'Matias, Yossi'],
    year: 2023,
    venue: 'ICML',
    tags: ['speculative decoding', 'inference'],
  },
  {
    key: 'lewis2020rag',
    type: 'inproceedings',
    title: 'Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks',
    authors: ['Lewis, Patrick', 'Perez, Ethan', 'Piktus, Aleksandra'],
    year: 2020,
    venue: 'NeurIPS',
    tags: ['retrieval', 'summarization'],
  },
  {
    key: 'chen2023accelerating',
    type: 'article',
    title: 'Accelerating Large Language Model Decoding with Speculative Sampling',
    authors: ['Chen, Charlie', 'Borgeaud, Sebastian', 'Irving, Geoffrey'],
    year: 2023,
    venue: 'arXiv',
    tags: ['speculative decoding', 'sampling'],
  },
  {
    key: 'zhang2024longcontext',
    type: 'article',
    title: 'Long-Context Scientific Summarization: A Benchmark Study',
    authors: ['Zhang, Wei', 'Raman, Priya'],
    year: 2024,
    venue: 'EMNLP',
    tags: ['summarization', 'benchmark'],
  },
  {
    key: 'pope2023efficiently',
    type: 'article',
    title: 'Efficiently Scaling Transformer Inference',
    authors: ['Pope, Reiner', 'Douglas, Sholto', 'Chowdhery, Aakanksha'],
    year: 2023,
    venue: 'MLSys',
    tags: ['inference', 'scaling'],
  },
];

export const DEMO_TERMINOLOGY: TerminologyEntry[] = [
  {
    id: 'term-sd',
    term: 'speculative decoding',
    translation: '投机解码',
    definition: '用小模型起草、大模型并行验证的加速解码范式。',
    forbidden: ['spec decoding', 'speculative sampling decoding'],
    locked: true,
  },
  {
    id: 'term-llm',
    term: 'large language model',
    translation: '大语言模型',
    definition: '参数量达到十亿级以上、经大规模语料预训练的语言模型。',
    forbidden: ['big language model', 'LLM model'],
    locked: true,
  },
  {
    id: 'term-rag',
    term: 'retrieval-augmented generation',
    translation: '检索增强生成',
    definition: '在生成前检索外部语料并拼接进上下文的生成方式。',
    forbidden: ['RAG generation', 'retrieval augmented generation'],
    locked: true,
  },
  {
    id: 'term-draft',
    term: 'draft model',
    translation: '草稿模型',
    definition: '投机解码中负责快速起草 token 的小模型。',
    forbidden: ['drafter model', 'drafting model'],
    locked: false,
  },
  {
    id: 'term-accept',
    term: 'acceptance rate',
    translation: '接受率',
    definition: '草稿 token 被目标模型接受的比例。',
    forbidden: ['accept ratio'],
    locked: false,
  },
];

export const DEMO_FIGURES: FigureAsset[] = [
  {
    id: 'fig-arch',
    label: 'fig:architecture',
    path: 'figures/architecture.pdf',
    caption: 'Overview of Adaptive Speculative Decoding: the draft policy chooses K per step from entropy and acceptance statistics.',
    referencedAt: [{ fileId: 'file-main', line: 58 }],
  },
  {
    id: 'fig-latency',
    label: 'fig:latency',
    path: 'figures/latency.pdf',
    caption: 'Latency versus context length for fixed-K speculative decoding and ASD.',
  },
];

export const DEMO_CONTEXT: SharedContext = {
  citations: DEMO_CITATIONS,
  terminology: DEMO_TERMINOLOGY,
  figures: DEMO_FIGURES,
  // 演示项目默认没有参考资料；用户添加的会出现在这里。
  references: [],
};
