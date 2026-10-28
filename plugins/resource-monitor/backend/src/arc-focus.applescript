use scripting additions

on run argv
    if (count of argv) is not 3 then error "Invalid target" number 6002
    if application id "company.thebrowser.Browser" is not running then error "Arc not running" number 6001
    set targetWindowID to item 2 of argv
    set targetTabID to item 3 of argv
    tell application id "company.thebrowser.Browser"
        with timeout of 10 seconds
            repeat with arcWindow in windows
                if ((id of arcWindow) as text) is targetWindowID then
                    if incognito of arcWindow is not false then error "Private window" number 6002
                    repeat with arcTab in tabs of arcWindow
                        if ((id of arcTab) as text) is targetTabID then
                            select arcTab
                            activate
                            return "ok"
                        end if
                    end repeat
                end if
            end repeat
        end timeout
    end tell
    error "Tab no longer exists" number 6002
end run
