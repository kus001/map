from time import monotonic_ns

def us():
    return monotonic_ns() // 1_000

def time_to_seconds(time_str):
    """Convert a time string in HH:MM:SS format to seconds since midnight."""
    h, m, s = map(int, time_str.split(':'))
    return h * 3600 + m * 60 + s

def seconds_to_time(seconds):
    """Convert seconds since midnight to a time string in HH:MM:SS format."""
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"

if __name__ == '__main__':
    print(time_to_seconds("15:03:00"))
