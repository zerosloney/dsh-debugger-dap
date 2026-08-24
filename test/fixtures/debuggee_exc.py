"""Debuggee that raises an exception (dsh-debugger-dap e2e)."""


def boom():
    value = 1 / 0   # line 5


if __name__ == "__main__":
    boom()
