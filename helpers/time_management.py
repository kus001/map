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

def delta_time(time_str1, time_str2):
    """Calculate the difference in seconds between two time strings in HH:MM:SS format."""
    return abs(time_to_seconds(time_str2) - time_to_seconds(time_str1))

def delta_time_in_minutes(time_str1, time_str2):
    dt = delta_time(time_str1, time_str2)
    return dt // 60, dt % 60