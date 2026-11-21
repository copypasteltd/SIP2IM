"""Parse adb device listings without invoking adb or starting services."""


def authorized_serials(output: str) -> list[str]:
    serials = []
    for line in output.splitlines():
        fields = line.split()
        if len(fields) >= 2 and fields[1] == "device":
            serials.append(fields[0])
    return serials
