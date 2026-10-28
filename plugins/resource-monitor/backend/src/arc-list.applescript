use framework "Foundation"
use scripting additions

on run argv
    if application id "company.thebrowser.Browser" is not running then error "Arc not running" number 6001
    set rows to current application's NSMutableArray's array()
    tell application id "company.thebrowser.Browser"
        with timeout of 10 seconds
            repeat with arcWindow in windows
                -- Arc's JXA bridge cannot coerce these properties (-1700).
                -- The application's AppleScript dictionary supports them directly.
                if incognito of arcWindow is false then
                    set windowID to (id of arcWindow) as text
                    set tabIDs to id of every tab of arcWindow
                    set tabTitles to title of every tab of arcWindow
                    if (id of every tab of arcWindow) is not tabIDs then error "Arc tabs changed" number 6002
                    if (count of tabIDs) is not (count of tabTitles) then error "Arc tabs changed" number 6002
                    repeat with tabIndex from 1 to count of tabIDs
                        if (rows's |count|()) as integer is greater than or equal to 500 then exit repeat
                        set tabTitle to item tabIndex of tabTitles
                        if tabTitle is missing value or tabTitle is "" then set tabTitle to "未命名标签"
                        set tabTitle to tabTitle as text
                        if (count of characters of tabTitle) is greater than 200 then set tabTitle to text 1 thru 200 of tabTitle
                        set row to current application's NSMutableDictionary's dictionary()
                        row's setObject:windowID forKey:"window"
                        row's setObject:((item tabIndex of tabIDs) as text) forKey:"tab"
                        row's setObject:tabTitle forKey:"title"
                        rows's addObject:row
                    end repeat
                end if
                if (rows's |count|()) as integer is greater than or equal to 500 then exit repeat
            end repeat
        end timeout
    end tell
    set jsonData to current application's NSJSONSerialization's dataWithJSONObject:rows options:0 |error|:(missing value)
    return (current application's NSString's alloc()'s initWithData:jsonData encoding:(current application's NSUTF8StringEncoding)) as text
end run
