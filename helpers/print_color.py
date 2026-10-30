"""
Copyright © 2026 Madhav Garg <gargm0325@wrdsb.ca>

Licensed under the MIT License (the "License"); you may not use this file 
except in compliance with the License. You may obtain a copy of the License 
at https://opensource.org

File sourced from: https://github.com/roc-ket-cod-er/Python-Transit-API/blob/main/src/print_color.py
"""

NORMAL_TEXT = "\033[0m"

RED = '\033[0;31m'
BLUE = '\033[0;34m'	
GREEN = '\033[0;32m'
YELLOW = '\033[0;33m'
MAGENTA = '\033[0;35m'

NORMAL = 'normal'

BOLD = '\033[1;37m'

def magenta(*strings, end='', bold=False):
    tbr = MAGENTA
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def red(*strings, end='', bold=False):
    tbr = RED
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def green(*strings, end='', bold=False):
    tbr = GREEN
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def blue(*strings, end='', bold=False):
    tbr = BLUE
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def yellow(*strings, end='', bold=False):
    tbr = YELLOW
    if bold: tbr[2] = 1
    for string in strings:
        tbr += str(string)
        if string != strings[-1]:
            tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr

def bold(*strings, end=''):
    tbr = BOLD
    for string in strings:
        if string[:4] != '\033[0;':
            tbr += str(string)
            if string != strings[-1]:
                tbr += ' '
        else:
            tbr += NORMAL_TEXT
            tbr += '\033[1;'
            tbr += string[4:]
            if string != strings[-1]:
                tbr += ' '
    tbr += NORMAL_TEXT
    tbr += end
    return tbr
