```python
import re
import sys

def check_financial_compliance(file_path: str):
    with open(file_path, 'r') as f:
        code = f.read()

    violations = []

    # Rule 1: Check for floats used in financial contexts
    if re.search(r'\b(float|double)\b.*\b(price|amount|balance|total|currency)\b', code, re.IGNORECASE):
        violations.append("CRITICAL: Potential use of float/double for financial variables. Use Decimal or int (cents).")

    # Rule 2: Check for missing audit logging in state changes
    if re.search(r'\b(def\s+(create|update|delete|process|apply|transfer))\b', code, re.IGNORECASE):
        if not re.search(r'logger\.(info|warning|error)\(.*AUDIT', code):
            violations.append("WARNING: State-changing function detected without an explicit 'AUDIT' log entry.")

    # Rule 3: Check for Jira traceability
    if not re.search(r'#\s*JIRA:\s*[A-Z]+-\d+', code):
        violations.append("WARNING: Missing Jira ticket reference in docstrings/comments.")

    if violations:
        print("❌ COMPLIANCE CHECK FAILED:")
        for v in violations:
            print(f"  - {v}")
        return False
    else:
        print("✅ COMPLIANCE CHECK PASSED: Code meets baseline FinTech standards.")
        return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python compliance_checker.py <file_path>")
        sys.exit(1)
    success = check_financial_compliance(sys.argv[1])
    sys.exit(0 if success else 1)
