def factorial(n):
    result = 1
    for i in range(1, n + 1):
        result = result * i
    return result


def main():
    total = 0
    for k in range(1, 5):
        total += factorial(k)
    print(f"total={total}")
    assert total == 34, f"expected 34, got {total}"


main()
