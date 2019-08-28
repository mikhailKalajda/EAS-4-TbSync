/*
 * This file is part of EAS-4-TbSync.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. 
 */

"use strict";

// Every object in here will be loaded into TbSync.providers.<providername>.
const eas = TbSync.providers.eas;

eas.prefs = Services.prefs.getBranch("extensions.eas4tbsync.");

//use flags instead of strings to avoid errors due to spelling errors
eas.flags = Object.freeze({
    allowEmptyResponse: true, 
});

eas.windowsTimezoneMap = {};
eas.cachedTimezoneData = null;
eas.defaultTimezoneInfo = null;
eas.defaultTimezone = null;
eas.utcTimezone = null;


/**
 * Implementing the TbSync interface for external provider extensions.
 */
var Base = class {
    /**
     * Called during load of external provider extension to init provider.
     */
    static async load() {
        // Set default prefs
        let branch = Services.prefs.getDefaultBranch("extensions.eas4tbsync.");
        branch.setIntPref("timeout", 90000);
        branch.setIntPref("maxitems", 50);
        branch.setCharPref("clientID.type", "TbSync");
        branch.setCharPref("clientID.useragent", "Thunderbird ActiveSync");    

        eas.defaultTimezone = null;
        eas.utcTimezone = null;
        eas.defaultTimezoneInfo = null;
        eas.windowsTimezoneMap = {};
        eas.openWindows = {};

        eas.overlayManager = new OverlayManager({verbose: 0});
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/abNewCardDialog.xul", "chrome://eas4tbsync/content/overlays/abNewCardWindow.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/abNewCardDialog.xul", "chrome://eas4tbsync/content/overlays/abCardWindow.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/abEditCardDialog.xul", "chrome://eas4tbsync/content/overlays/abCardWindow.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/addressbook.xul", "chrome://eas4tbsync/content/overlays/addressbookoverlay.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/addressbook.xul", "chrome://eas4tbsync/content/overlays/addressbookdetailsoverlay.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/addressbook.xul", "chrome://eas4tbsync/content/overlays/abServerSearch.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/abContactsPanel.xul", "chrome://eas4tbsync/content/overlays/abServerSearch.xul");

        // The abCSS.xul overlay is just adding a CSS file.
        await eas.overlayManager.registerOverlay("chrome://messenger/content/messengercompose/messengercompose.xul", "chrome://eas4tbsync/content/overlays/abCSS.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/abNewCardDialog.xul", "chrome://eas4tbsync/content/overlays/abCSS.xul");
        await eas.overlayManager.registerOverlay("chrome://messenger/content/addressbook/addressbook.xul", "chrome://eas4tbsync/content/overlays/abCSS.xul");

        eas.overlayManager.startObserving();
                
        try {
            // Create a basic error info (no accountname or foldername, just the provider)
            let eventLogInfo = new TbSync.EventLogInfo("eas");
            
            if (TbSync.lightning.isAvailable()) {
                
                //get timezone info of default timezone (old cal. without dtz are depricated)
                eas.defaultTimezone = (TbSync.lightning.cal.dtz && TbSync.lightning.cal.dtz.defaultTimezone) ? TbSync.lightning.cal.dtz.defaultTimezone : TbSync.lightning.cal.calendarDefaultTimezone();
                eas.utcTimezone = (TbSync.lightning.cal.dtz && TbSync.lightning.cal.dtz.UTC) ? TbSync.lightning.cal.dtz.UTC : TbSync.lightning.cal.UTC();
                if (eas.defaultTimezone && eas.defaultTimezone.icalComponent) {
                    TbSync.eventlog.add("info", eventLogInfo, "Default timezone has been found.");                    
                } else {
                    TbSync.eventlog.add("info", eventLogInfo, "Default timezone is not defined, using UTC!");
                    eas.defaultTimezone = eas.utcTimezone;
                }

                eas.defaultTimezoneInfo = eas.tools.getTimezoneInfo(eas.defaultTimezone);
                if (!eas.defaultTimezoneInfo) {
                    TbSync.eventlog.add("info", eventLogInfo, "Could not create defaultTimezoneInfo");
                }
                
                //get windows timezone data from CSV
                let csvData = await eas.tools.fetchFile("chrome://eas4tbsync/content/timezonedata/WindowsTimezone.csv");
                for (let i = 0; i<csvData.length; i++) {
                    let lData = csvData[i].split(",");
                    if (lData.length<3) continue;
                    
                    let windowsZoneName = lData[0].toString().trim();
                    let zoneType = lData[1].toString().trim();
                    let ianaZoneName = lData[2].toString().trim();
                    
                    if (zoneType == "001") eas.windowsTimezoneMap[windowsZoneName] = ianaZoneName;
                    if (ianaZoneName == eas.defaultTimezoneInfo.std.id) eas.defaultTimezoneInfo.std.windowsZoneName = windowsZoneName;
                }


                //If an EAS calendar is currently NOT associated with an email identity, try to associate, 
                //but do not change any explicitly set association
                // - A) find email identity and accociate (which sets organizer to that user identity)
                // - B) overwrite default organizer with current best guess
                //TODO: Do this after email accounts changed, not only on restart? 
                let providerData = new TbSync.ProviderData("eas");
                let folders = providerData.getFolders({"selected": true, "type": ["8","13"]});
                for (let folder of folders) {
                    let calendar = TbSync.lightning.cal.getCalendarManager().getCalendarById(folder.getFolderProperty("target"));
                    if (calendar && calendar.getProperty("imip.identity.key") == "") {
                        //is there an email identity for this eas account?
                        let authData = eas.network.getAuthData(folder.accountData);

                        let key = eas.tools.getIdentityKey(authData.user);
                        if (key === "") { //TODO: Do this even after manually switching to NONE, not only on restart?
                            //set transient calendar organizer settings based on current best guess and 
                            calendar.setProperty("organizerId", TbSync.lightning.cal.email.prependMailTo(authData.user));
                            calendar.setProperty("organizerCN",  calendar.getProperty("fallbackOrganizerName"));
                        } else {                      
                            //force switch to found identity
                            calendar.setProperty("imip.identity.key", key);
                        }
                    }
                }
            } else {
                    TbSync.eventlog.add("info", eventLogInfo, "Lightning was not loaded, creation of timezone objects has been skipped.");
            }
        } catch(e) {
            Components.utils.reportError(e);        
        }        
    }


    /**
     * Called during unload of external provider extension to unload provider.
     */
    static async unload() {
        eas.overlayManager.stopObserving();	

        // Close all open windows of this provider.
        for (let id in eas.openWindows) {
          if (eas.openWindows.hasOwnProperty(id)) {
            eas.openWindows[id].close();
          }
        }
    }


    /**
     * Returns string for the name of provider for the add account menu.
     */
    static getProviderName() {
        return "Exchange ActiveSync";
    }


    /**
     * Returns version of the TbSync API this provider is using
     */
    static getApiVersion() { return "2.1"; }


    /**
     * Returns location of a provider icon.
     */
    static getProviderIcon(size, accountData = null) {
        switch (size) {
            case 16:
                return "chrome://eas4tbsync/skin/eas16.png";
            case 32:
                return "chrome://eas4tbsync/skin/eas32.png";
            default :
                return "chrome://eas4tbsync/skin/eas64.png";
        }
    }


    /**
     * Returns a list of sponsors, they will be sorted by the index
     */
    static getSponsors() {
        return {
            "Schiessl, Michael 1" : {name: "Michael Schiessl", description: "Tine 2.0", icon: "", link: "" },
            "Schiessl, Michael 2" : {name: "Michael Schiessl", description: " Exchange 2007", icon: "", link: "" },
            "netcup GmbH" : {name: "netcup GmbH", description : "SOGo", icon: "chrome://eas4tbsync/skin/sponsors/netcup.png", link: "http://www.netcup.de/" },
            "nethinks GmbH" : {name: "nethinks GmbH", description : "Zarafa", icon: "chrome://eas4tbsync/skin/sponsors/nethinks.png", link: "http://www.nethinks.com/" },
            "Jau, Stephan" : {name: "Stephan Jau", description: "Horde", icon: "", link: "" },
            "Zavar " : {name: "Zavar", description: "Zoho", icon: "", link: "" },
        };
    }


    /**
     * Returns the email address of the maintainer (used for bug reports).
     */
    static getMaintainerEmail() {
        return "john.bieling@gmx.de";
    }


    /**
     * Returns the URL of the string bundle file of this provider, it can be
     * accessed by TbSync.getString(<key>, <provider>)
     */
    static getStringBundleUrl() {
        return "chrome://eas4tbsync/locale/eas.strings";
    }


    /**
     * Returns URL of the new account window.
     *
     * The URL will be opened via openDialog(), when the user wants to create a
     * new account of this provider.
     */
    static getCreateAccountWindowUrl() {
        return "chrome://eas4tbsync/content/manager/createAccount.xul";
    }


    /**
     * Returns overlay XUL URL of the edit account dialog
     * (chrome://tbsync/content/manager/editAccount.xul)
     */
    static getEditAccountOverlayUrl() {
        return "chrome://eas4tbsync/content/manager/editAccountOverlay.xul";
    }


    /**
     * Return object which contains all possible fields of a row in the
     * accounts database with the default value if not yet stored in the 
     * database.
     */
    static getDefaultAccountEntries() {
        let row = {
            "policykey" : "0", 
            "foldersynckey" : "0",
            "deviceId" : eas.tools.getNewDeviceId(),
            "asversionselected" : "auto",
            "asversion" : "",
            "host" : "",
            "user" : "",
            "servertype" : "",
            "seperator" : "10",
            "https" : true,
            "provision" : false,
            "displayoverride" : false, 
            "lastEasOptionsUpdate":"0",
            "allowedEasVersions": "",
            "allowedEasCommands": "",
            "useragent": eas.prefs.getCharPref("clientID.useragent"),
            "devicetype": eas.prefs.getCharPref("clientID.type"),
            "galautocomplete": true, 
            "synclimit" : "7",
            }; 
        return row;
    }


    /**
     * Return object which contains all possible fields of a row in the folder 
     * database with the default value if not yet stored in the database.
     */
    static getDefaultFolderEntries() {
        let folder = {
            "type" : "",
            "synckey" : "",
            "target" : "",
            "targetColor" : "",
            "parentID" : "0",
            "serverID" : "",
            };
        return folder;
    }


    /**
     * Is called everytime an account of this provider is enabled in the
     * manager UI.
     */
    static onEnableAccount(accountData) {
        accountData.resetAccountProperty("policykey");
        accountData.resetAccountProperty("foldersynckey");
        accountData.resetAccountProperty("lastEasOptionsUpdate");
        accountData.resetAccountProperty("lastsynctime");
    }


    /**
     * Is called everytime an account of this provider is disabled in the
     * manager UI.
     *
     * @param accountData  [in] AccountData
     */
    static onDisableAccount(accountData) {
    }


    /**
     * Implement this method, if this provider should add additional entries
     * to the autocomplete list while typing something into the address field
     * of the message composer.
     */
    static async abAutoComplete(accountData, currentQuery)  {
        let data = [];

        if (currentQuery.length < 3)
            return null;
        
        if (!accountData.getAccountProperty("allowedEasCommands").split(",").includes("Search")) {
            return null;
        }

        if (!accountData.getAccountProperty("galautocomplete")) {
            return null;
        }
            
        let response = await eas.network.getSearchResults(accountData, currentQuery);
        let wbxmlData = eas.network.getDataFromResponse(response);

        if (wbxmlData.Search && wbxmlData.Search.Response && wbxmlData.Search.Response.Store && wbxmlData.Search.Response.Store.Result) {
            let results = eas.xmltools.nodeAsArray(wbxmlData.Search.Response.Store.Result);
            let accountname = accountData.getAccountProperty("accountname");
        
            for (let count = 0; count < results.length; count++) {
                if (results[count].Properties) {
                    //TbSync.window.console.log('Found contact:' + results[count].Properties.DisplayName);
                    data.push({
                        value: results[count].Properties.DisplayName + " <" + results[count].Properties.EmailAddress + ">", 
                        comment: TbSync.getString("autocomplete.serverdirectory", "eas") + " ("+accountData.getAccountProperty("accountname")+")",
                        icon: eas.Base.getProviderIcon(16, accountData),
                        style: "EASGAL",
                    });
                }
            }
        }
        
        return data;
    }


    /**
     * Returns all folders of the account, sorted in the desired order.
     * The most simple implementation is to return accountData.getAllFolders();
     */
    static getSortedFolders(accountData) {
        let allowedTypesOrder = ["9","14","8","13","7","15"];
        
        function getIdChain (aServerID) {
            let serverID = aServerID;
            let chain = [];
            let folder;
            let rootType = "";
            
            // create sort string so that child folders are directly below their parent folders
            do { 
                folder = accountData.getFolder("serverID", serverID);
                if (folder) {
                    chain.unshift(folder.getFolderProperty("foldername"));
                    serverID = folder.getFolderProperty("parentID");
                    rootType = folder.getFolderProperty("type");
                }
            } while (folder && serverID != "0")
            
            // different folder types are grouped and trashed folders at the end
            let pos = allowedTypesOrder.indexOf(rootType);
            chain.unshift(pos == -1 ? "ZZZ" : pos.toString().padStart(3,"0"));
                        
            return chain.join(".");
        };
        
        let toBeSorted = [];
        let folders = accountData.getAllFolders();
        for (let f of folders) {
            if (!allowedTypesOrder.includes(f.getFolderProperty("type"))) {
                continue;
            }
            toBeSorted.push({"key": getIdChain(f.getFolderProperty("serverID")), "folder": f});
        }
        
        //sort
        toBeSorted.sort(function(a,b) {
            return  a.key > b.key;
        });

        let sortedFolders = [];
        for (let sortObj of toBeSorted) {
            sortedFolders.push(sortObj.folder);
        }
        return sortedFolders;        
    }


    /**
     * Return the connection timeout for an active sync, so TbSync can append
     * a countdown to the connection timeout, while waiting for an answer from
     * the server. Only syncstates which start with "send." will trigger this.
     */
    static getConnectionTimeout(accountData) {
        return eas.prefs.getIntPref("timeout");
    }
    

    /**
     * Is called if TbSync needs to synchronize the folder list.
     */
    static async syncFolderList(syncData, syncJob, syncRunNr) {
        // Recommendation: Put the actual function call inside a try catch, to
        // ensure returning a proper StatusData object, regardless of what
        // happens inside that function. You may also throw custom errors
        // in that function, which have the StatusData obj attached, which
        // should be returned.
        
        try {
            await eas.sync.folderList(syncData);
        } catch (e) {
            if (e.name == "eas4tbsync") {
                return e.statusData;
            } else {
                Components.utils.reportError(e);
                // re-throw any other error and let TbSync handle it
                throw (e);
            }
        }

        // Fall through, if there was no error.
        return new TbSync.StatusData();        
    }


    /**
     * Is called if TbSync needs to synchronize a folder.
     */
    static async syncFolder(syncData, syncJob, syncRunNr) {
        // Recommendation: Put the actual function call inside a try catch, to
        // ensure returning a proper StatusData object, regardless of what
        // happens inside that function. You may also throw custom errors
        // in that function, which have the StatusData obj attached, which
        // should be returned.
        
        try {
            switch (syncJob) {
                case "deletefolder":
                    await eas.sync.deleteFolder(syncData);
                    break;
                default:
                   await eas.sync.singleFolder(syncData);
            }
        } catch (e) {
            if (e.name == "eas4tbsync") {
                return e.statusData;
            } else {
                Components.utils.reportError(e);
                // re-throw any other error and let TbSync handle it
                throw (e);
            }
        }

        // Fall through, if there was no error.
        return new TbSync.StatusData();   
    }
}




// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
// * TargetData implementation
// * Using TbSyncs advanced address book TargetData 
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

var TargetData_addressbook = class extends TbSync.addressbook.AdvancedTargetData {
    constructor(folderData) {
        super(folderData);
    }

    get primaryKeyField() {
        return "X-EAS-SERVERID";
    }
    
    generatePrimaryKey() {
         return TbSync.generateUUID();
    }

    // enable or disable changelog
    get logUserChanges() {
        return  true;
    }

    directoryObserver(aTopic) {
        switch (aTopic) {
            case "addrbook-removed":
            case "addrbook-updated":
                //Services.console.logStringMessage("["+ aTopic + "] " + this.folderData.getFolderProperty("foldername"));
                break;
        }
    }

    cardObserver(aTopic, abCardItem) {
        switch (aTopic) {
            case "addrbook-contact-updated":
            case "addrbook-contact-removed":
                //Services.console.logStringMessage("["+ aTopic + "] " + abCardItem.getProperty("DisplayName"));
                break;

            case "addrbook-contact-created":
            {
                //Services.console.logStringMessage("["+ aTopic + "] "+ abCardItem.getProperty("DisplayName")+">");
                break;
            }
        }
    }

    listObserver(aTopic, abListItem, abListMember) {
        switch (aTopic) {
            case "addrbook-list-member-added":
            case "addrbook-list-member-removed":
                //Services.console.logStringMessage("["+ aTopic + "] MemberName: " + abListMember.getProperty("DisplayName"));
                break;
            
            case "addrbook-list-removed":
            case "addrbook-list-updated":
                //Services.console.logStringMessage("["+ aTopic + "] ListName: " + abListItem.getProperty("ListName"));
                break;
            
            case "addrbook-list-created": 
                //Services.console.logStringMessage("["+ aTopic + "] ListName: "+abListItem.getProperty("ListName")+">");
                break;
        }
    }
    
    createAddressbook(newname) {
        let dirPrefId = MailServices.ab.newAddressBook(newname, "", 2);  /* kPABDirectory - return abManager.newAddressBook(name, "moz-abmdbdirectory://", 2); */
        let directory = MailServices.ab.getDirectoryFromId(dirPrefId);
        
        eas.sync.resetFolderSyncInfo(this.folderData);
        
        if (directory && directory instanceof Components.interfaces.nsIAbDirectory && directory.dirPrefId == dirPrefId) {
            directory.setStringValue("tbSyncIcon", "eas");
            return directory;		
        }
        return null;
    }
}



// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *
// * TargetData implementation
// * Using TbSyncs advanced calendar TargetData 
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * *

var TargetData_calendar = class extends TbSync.lightning.AdvancedTargetData {
    constructor(folderData) {
        super(folderData);
    }       
        
    // The calendar target does not support a custom primaryKeyField, because
    // the lightning implementation only allows to search for items via UID.
    // Like the addressbook target, the calendar target item element has a
    // primaryKey getter/setter which - however - only works on the UID.
    
    // enable or disable changelog
    get logUserChanges() {
        return true;
    }

    calendarObserver(aTopic, tbCalendar, aPropertyName, aPropertyValue, aOldPropertyValue) {
        switch (aTopic) {
            case "onCalendarPropertyChanged":
                //Services.console.logStringMessage("["+ aTopic + "] " + tbCalendar.calendar.name + " : " + aPropertyName);
                break;
            
            case "onCalendarDeleted":
            case "onCalendarPropertyDeleted":
                //Services.console.logStringMessage("["+ aTopic + "] " +tbCalendar.calendar.name);
                break;
        }
    }
    
    itemObserver(aTopic, tbItem, tbOldItem) {
        switch (aTopic) {
            case "onAddItem":
            case "onModifyItem":
            case "onDeleteItem":
                //Services.console.logStringMessage("["+ aTopic + "] " + tbItem.nativeItem.title);
                break;
        }
    }

    createCalendar(newname) {
        let calManager = TbSync.lightning.cal.getCalendarManager();
        //Alternative calendar, which uses calTbSyncCalendar
        //let newCalendar = calManager.createCalendar("TbSync", Services.io.newURI('tbsync-calendar://'));

        //Create the new standard calendar with a unique name
        let newCalendar = calManager.createCalendar("storage", Services.io.newURI("moz-storage-calendar://"));
        newCalendar.id = TbSync.lightning.cal.getUUID();
        newCalendar.name = newname;

        eas.sync.resetFolderSyncInfo(this.folderData);

        newCalendar.setProperty("color", this.folderData.getFolderProperty("targetColor"));
        newCalendar.setProperty("relaxedMode", true); //sometimes we get "generation too old for modifyItem", check can be disabled with relaxedMode
        newCalendar.setProperty("calendar-main-in-composite",true);
        newCalendar.setProperty("readOnly", this.folderData.getFolderProperty("downloadonly") == "1");
        calManager.registerCalendar(newCalendar);

        let authData = eas.network.getAuthData(this.folderData.accountData);
        
        //is there an email identity we can associate this calendar to? 
        //getIdentityKey returns "" if none found, which removes any association
        let key = eas.tools.getIdentityKey(authData.user);
        newCalendar.setProperty("fallbackOrganizerName", newCalendar.getProperty("organizerCN"));
        newCalendar.setProperty("imip.identity.key", key);
        if (key === "") {
            //there is no matching email identity - use current default value as best guess and remove association
            //use current best guess 
            newCalendar.setProperty("organizerCN", newCalendar.getProperty("fallbackOrganizerName"));
            newCalendar.setProperty("organizerId", TbSync.lightning.cal.email.prependMailTo(authData.user));
        }
        
        return newCalendar;
    }
}





/**
 * This provider is implementing the StandardFolderList class instead of
 * the FolderList class.
 */
var StandardFolderList = class {
    /**
     * Is called before the context menu of the folderlist is shown, allows to
     * show/hide custom menu options based on selected folder. During an active
     * sync, folderData will be null.
     */
    static onContextMenuShowing(window, folderData) {
        let hideContextMenuDelete = true;
        if (folderData !== null) {
            //if a folder in trash is selected, also show ContextMenuDelete (but only if FolderDelete is allowed)
            if (eas.tools.parentIsTrash(folderData) && folderData.accountData.getAccountProperty("allowedEasCommands").split(",").includes("FolderDelete")) {
                hideContextMenuDelete = false;
                window.document.getElementById("TbSync.eas.FolderListContextMenuDelete").label = TbSync.getString("deletefolder.menuentry::" + folderData.getFolderProperty("foldername"), "eas");
            }                
        }
        window.document.getElementById("TbSync.eas.FolderListContextMenuDelete").hidden = hideContextMenuDelete;
    }


    /**
     * Return the icon used in the folderlist to represent the different folder
     * types.
     */
    static getTypeImage(folderData) {
        let src = "";
        switch (folderData.getFolderProperty("type")) {
            case "9": 
            case "14": 
                src = "contacts16.png";
                break;
            case "8":
            case "13":
                src = "calendar16.png";
                break;
            case "7":
            case "15":
                src = "todo16.png";
                break;
        }
        return "chrome://tbsync/skin/" + src;
    }


    /**
     * Return the name of the folder shown in the folderlist.
     */ 
    static getFolderDisplayName(folderData) {
        let folderName = folderData.getFolderProperty("foldername");
        if (eas.tools.parentIsTrash(folderData)) folderName = TbSync.getString("recyclebin", "eas") + " | " + folderName;
        return folderName;
    }
    

    /**
     * Return the attributes for the ACL RO (readonly menu element per folder.
     * (label, disabled, hidden, style, ...)
     *
     * Return a list of attributes and their values If both (RO+RW) do
     * not return any attributes, the ACL menu is not displayed at all.
     */ 
    static getAttributesRoAcl(folderData) {
        return {
            label: TbSync.getString("acl.readonly", "eas"),
        };
    }
    

    /**
     * Return the attributes for the ACL RW (readwrite) menu element per folder.
     * (label, disabled, hidden, style, ...)
     *
     * Return a list of attributes and their values. If both (RO+RW) do
     * not return any attributes, the ACL menu is not displayed at all.
     */ 
    static getAttributesRwAcl(folderData) {
        return {
            label: TbSync.getString("acl.readwrite", "eas"),
        }             
    }
}

Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/network.js", this, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/wbxmltools.js", this, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/xmltools.js", this, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/tools.js", this, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/sync.js", this, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/contactsync.js", this.sync, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/calendarsync.js", this.sync, "UTF-8");
Services.scriptloader.loadSubScript("chrome://eas4tbsync/content/includes/tasksync.js", this.sync, "UTF-8");
