#!/usr/bin/env python3
"""
许愿式编程 · 四个小案例
============================================================

许愿式编程（wishful programming）的姿势只有一句话：

    先把"如果世上已经有这东西，我会怎么用它"写下来，
    再让实现去追那行调用。

调用点不是实现的副产品，而是实现的目标。下面四个案例，
每个都先给愿望（三五行、可执行），再给兑现愿望所需的最小实现。
"""

from __future__ import annotations

import itertools
import re


def banner(title: str) -> None:
    print(f"\n{'─' * 62}\n{title}\n{'─' * 62}")


# ══════════════════════════════════════════════════════════════
# 案例 1 · 计算器
# 愿望：存在一个函数，能直接读懂写在纸上的算式
#
#     calc("1 + 2 * 3")        == 7
#     calc("(1 + 2) * 3")      == 9
#     calc("2 * (3 + 4) - 5")  == 9
#     calc("-3 + 10 / 4")      == -0.5
#
# 愿望里已经藏着文法：算式 → 项 → 因子。
# 剩下的只是把这层文法照抄成一个类。
# ══════════════════════════════════════════════════════════════

TOKEN = re.compile(r"\d+\.?\d*|[-+*/()]")


class _Expr:
    def __init__(self, tokens: list[str]) -> None:
        self.tokens = tokens
        self.i = 0

    def peek(self) -> str | None:
        return self.tokens[self.i] if self.i < len(self.tokens) else None

    def eat(self, expect: str | None = None) -> str:
        tok = self.peek()
        if tok is None:
            raise SyntaxError("算式意外结束")
        if expect is not None and tok != expect:
            raise SyntaxError(f"期望 {expect!r}，得到 {tok!r}")
        self.i += 1
        return tok

    # 算式 := 项 (('+' | '-') 项)*
    def expr(self) -> float:
        value = self.term()
        while self.peek() in ("+", "-"):
            op = self.eat()
            rhs = self.term()
            value = value + rhs if op == "+" else value - rhs
        return value

    # 项 := 因子 (('*' | '/') 因子)*
    def term(self) -> float:
        value = self.factor()
        while self.peek() in ("*", "/"):
            op = self.eat()
            rhs = self.factor()
            value = value * rhs if op == "*" else value / rhs
        return value

    # 因子 := 数字 | '(' 算式 ')' | '-' 因子
    def factor(self) -> float:
        tok = self.peek()
        if tok == "-":
            self.eat()
            return -self.factor()
        if tok == "(":
            self.eat("(")
            value = self.expr()
            self.eat(")")
            return value
        if tok is None:
            raise SyntaxError("算式意外结束")
        return float(self.eat())


def calc(source: str) -> float | int:
    value = _Expr(TOKEN.findall(source)).expr()
    return int(value) if float(value).is_integer() else value


# ══════════════════════════════════════════════════════════════
# 案例 2 · 素数
# 愿望：一条"取之不尽"的数列
#
#     PRIMES.take(8)        == [2, 3, 5, 7, 11, 13, 17, 19]
#     PRIMES.nth(100)       == 547        # 第 101 个素数
#     PRIMES.map(sq).take(4) == [4, 9, 25, 49]
#
# 兑现它只需要两件事：一个会缓存的惰性流，
# 和一行几乎是素数的定义的埃氏筛。
# ══════════════════════════════════════════════════════════════


class Stream:
    """惰性序列：取到才算，算过就记住。"""

    def __init__(self, produce):
        self._produce = produce          # () -> iterator
        self._cache: list = []
        self._it = None

    def __iter__(self):
        i = 0
        while True:
            if i < len(self._cache):
                yield self._cache[i]
            else:
                if self._it is None:
                    self._it = iter(self._produce())
                try:
                    value = next(self._it)
                except StopIteration:
                    return
                self._cache.append(value)
                yield value
            i += 1

    def take(self, n: int) -> list:
        return list(itertools.islice(self, n))

    def nth(self, n: int):
        return next(itertools.islice(self, n, n + 1))

    def map(self, fn) -> "Stream":
        return Stream(lambda: (fn(x) for x in self))

    def filter(self, keep) -> "Stream":
        return Stream(lambda: (x for x in self if keep(x)))


def _sieve(s: Stream) -> Stream:
    """s 的第一个数是素数 p；后面所有能被 p 整除的数都可以扔了。"""
    p = next(iter(s))
    rest = s.filter(lambda n, p=p: n % p)
    return Stream(lambda: itertools.chain([p], _sieve(rest)))


PRIMES = _sieve(Stream(lambda: itertools.count(2)))


# ══════════════════════════════════════════════════════════════
# 案例 3 · 查询
# 愿望：像说英语一样说"要哪些行"
#
#     Query(USERS)
#         .where(lambda u: u.age >= 30)
#         .order_by("age", desc=True)
#         .pick("name", "age")
#         .limit(3)
#         .all()
#
# 每一步都是一个不可变的新结果，链上任何一环都能单独读。
# ══════════════════════════════════════════════════════════════


class Row(dict):
    """让 u.age 和 u["age"] 等价，愿望就能写得更顺。"""

    __getattr__ = dict.__getitem__


class Query:
    def __init__(self, rows=()) -> None:
        self.rows: tuple[Row, ...] = tuple(rows)

    def where(self, keep) -> "Query":
        return Query(r for r in self.rows if keep(r))

    def order_by(self, key: str, desc: bool = False) -> "Query":
        return Query(sorted(self.rows, key=lambda r: r[key], reverse=desc))

    def pick(self, *keys: str) -> "Query":
        return Query(Row({k: r[k] for k in keys}) for r in self.rows)

    def limit(self, n: int) -> "Query":
        return Query(self.rows[:n])

    def all(self) -> list[Row]:
        return list(self.rows)

    def __repr__(self) -> str:
        return f"Query(<{len(self.rows)} rows>)"


USERS = [
    Row(name="Ada", age=36, city="London"),
    Row(name="Grace", age=45, city="Arlington"),
    Row(name="Alan", age=28, city="Wilmslow"),
    Row(name="Barbara", age=52, city="New York"),
    Row(name="Edsger", age=39, city="Rotterdam"),
]


# ══════════════════════════════════════════════════════════════
# 案例 4 · 表格
# 愿望：一张会自己重算的纸
#
#     SHEET["总价"] 随 "单价" / "数量" 变化，不用手动刷新
#
# 单元格里放函数，读的时候才求值 —— 公式就是代码，
# 依赖关系由 Python 的求值顺序自动决定。
# ══════════════════════════════════════════════════════════════


class Sheet(dict):
    def __getitem__(self, key):
        value = super().__getitem__(key)
        return value(self) if callable(value) else value


def main() -> None:
    banner("案例 1 · 计算器：愿望是一个能读懂算式的函数")
    for source in ["1 + 2 * 3", "(1 + 2) * 3", "2 * (3 + 4) - 5", "-3 + 10 / 4"]:
        call = f"calc({source!r})"
        print(f"  {call:<30} = {calc(source)}")

    banner("案例 2 · 素数：愿望是一条取之不尽的数列")
    print("  PRIMES.take(8)          =", PRIMES.take(8))
    print("  PRIMES.nth(100)         =", PRIMES.nth(100))
    print("  PRIMES.map(sq).take(4)  =", PRIMES.map(lambda p: p * p).take(4))

    banner("案例 3 · 查询：愿望是说人话")
    top = (
        Query(USERS)
        .where(lambda u: u.age >= 30)
        .order_by("age", desc=True)
        .pick("name", "age")
        .limit(3)
        .all()
    )
    for row in top:
        print(f"  {row['name']:<10} {row['age']}")

    banner("案例 4 · 表格：愿望是一张会自己重算的纸")
    sheet = Sheet()
    sheet["单价"] = 100
    sheet["数量"] = 3
    sheet["小计"] = lambda s: s["单价"] * s["数量"]
    sheet["折扣"] = lambda s: 0.9 if s["小计"] > 250 else 1.0
    sheet["总价"] = lambda s: round(s["小计"] * s["折扣"], 2)
    print(f"  单价 {sheet['单价']} × 数量 {sheet['数量']} = 总价 {sheet['总价']}")
    sheet["数量"] = 5
    print(f"  单价 {sheet['单价']} × 数量 {sheet['数量']} = 总价 {sheet['总价']}  ← 只改了数量")

    print()


if __name__ == "__main__":
    main()
