import { d20Roll, damageRoll } from "../dice.js";
import SelectItemsPrompt from "../apps/select-items-prompt.js";
import ShortRestDialog from "../apps/short-rest.js";
import LongRestDialog from "../apps/long-rest.js";
import {SW5E} from '../config.js';
import Item5e from "../item/entity.js";

/**
 * Extend the base Actor class to implement additional system-specific logic for SW5e.
 * @extends {Actor}
 */
export default class Actor5e extends Actor {

  /**
   * The data source for Actor5e.classes allowing it to be lazily computed.
   * @type {Object<string, Item5e>}
   * @private
   */
  _classes = undefined;

  /* -------------------------------------------- */
  /*  Properties                                  */
  /* -------------------------------------------- */

  /**
   * A mapping of classes belonging to this Actor.
   * @type {Object<string, Item5e>}
   */
  get classes() {
    if ( this._classes !== undefined ) return this._classes;
    if ( this.data.type !== "character" ) return this._classes = {};
    return this._classes = this.items.filter((item) => item.type === "class").reduce((obj, cls) => {
      obj[cls.name.slugify({strict: true})] = cls;
      return obj;
    }, {});
  }

  /* -------------------------------------------- */

  /**
   * Is this Actor currently polymorphed into some other creature?
   * @type {boolean}
   */
  get isPolymorphed() {
    return this.getFlag("sw5e", "isPolymorphed") || false;
  }

  /* -------------------------------------------- */
  /*  Methods                                     */
  /* -------------------------------------------- */

  /** @override */
  prepareData() {
    super.prepareData();

    // iterate over owned items and recompute attributes that depend on prepared actor data
    this.items.forEach(item => item.prepareFinalAttributes());
  }

  /* -------------------------------------------- */

  /** @override */
  prepareBaseData() {
    switch ( this.data.type ) {
      case "character":
        return this._prepareCharacterData(this.data);
      case "npc":
        return this._prepareNPCData(this.data);
      case "starship":
        return this._prepareStarshipData(this.data);
      case "vehicle":
        return this._prepareVehicleData(this.data);
    }
  }

  /* -------------------------------------------- */

  /** @override */
  prepareDerivedData() {
    const actorData = this.data;
    const data = actorData.data;
    const flags = actorData.flags.sw5e || {};
    const bonuses = getProperty(data, "bonuses.abilities") || {};

    // Retrieve data for polymorphed actors
    let originalSaves = null;
    let originalSkills = null;
    if (this.isPolymorphed) {
      const transformOptions = this.getFlag('sw5e', 'transformOptions');
      const original = game.actors?.get(this.getFlag('sw5e', 'originalActor'));
      if (original) {
        if (transformOptions.mergeSaves) {
          originalSaves = original.data.data.abilities;
        }
        if (transformOptions.mergeSkills) {
          originalSkills = original.data.data.skills;
        }
      }
    }

    // Ability modifiers and saves
    const dcBonus = Number.isNumeric(data.bonuses?.power?.dc) ? parseInt(data.bonuses.power.dc) : 0;
    const saveBonus = Number.isNumeric(bonuses.save) ? parseInt(bonuses.save) : 0;
    const checkBonus = Number.isNumeric(bonuses.check) ? parseInt(bonuses.check) : 0;
    for (let [id, abl] of Object.entries(data.abilities)) {
      abl.mod = Math.floor((abl.value - 10) / 2);
      abl.prof = (abl.proficient || 0) * data.attributes.prof;
      abl.saveBonus = saveBonus;
      abl.checkBonus = checkBonus;
      abl.save = abl.mod + abl.prof + abl.saveBonus;
      abl.dc = 8 + abl.mod + data.attributes.prof + dcBonus;

      // If we merged saves when transforming, take the highest bonus here.
      if (originalSaves && abl.proficient) {
        abl.save = Math.max(abl.save, originalSaves[id].save);
      }
    }

    // Inventory encumbrance
    data.attributes.encumbrance = this._computeEncumbrance(actorData);

    // Prepare skills
    this._prepareSkills(actorData, bonuses, checkBonus, originalSkills);

    // Reset class store to ensure it is updated with any changes
    this._classes = undefined;

    // Determine Initiative Modifier
    const init = data.attributes.init;
    const athlete = flags.remarkableAthlete;
    const joat = flags.jackOfAllTrades;
    init.mod = data.abilities.dex.mod;
    if ( joat ) init.prof = Math.floor(0.5 * data.attributes.prof);
    else if ( athlete ) init.prof = Math.ceil(0.5 * data.attributes.prof);
    else init.prof = 0;
    init.value = init.value ?? 0;
    init.bonus = init.value + (flags.initiativeAlert ? 5 : 0);
    init.total = init.mod + init.prof + init.bonus;

    // Cache labels
    this.labels = {};
    if ( this.type === "npc" ) {
      this.labels["creatureType"] = this.constructor.formatCreatureType(data.details.type);
    }

    // Prepare power-casting data
    this._computePowercastingProgression(this.data);
  }

  /* -------------------------------------------- */

  /**
   * Return the amount of experience required to gain a certain character level.
   * @param level {Number}  The desired level
   * @return {Number}       The XP required
   */
  getLevelExp(level) {
    const levels = CONFIG.SW5E.CHARACTER_EXP_LEVELS;
    return levels[Math.min(level, levels.length - 1)];
  }

  /* -------------------------------------------- */

  /**
   * Return the amount of experience granted by killing a creature of a certain CR.
   * @param cr {Number}     The creature's challenge rating
   * @return {Number}       The amount of experience granted per kill
   */
  getCRExp(cr) {
    if (cr < 1.0) return Math.max(200 * cr, 10);
    return CONFIG.SW5E.CR_EXP_LEVELS[cr];
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  getRollData() {
    const data = super.getRollData();
    data.prof = this.data.data.attributes.prof || 0;
    data.classes = Object.entries(this.classes).reduce((obj, e) => {
      const [slug, cls] = e;
      obj[slug] = cls.data.data;
      return obj;
    }, {});
    return data;
  }

  /* -------------------------------------------- */

  /**
   * Given a list of items to add to the Actor, optionally prompt the
   * user for which they would like to add.
   * @param {Array.<Item5e>} items - The items being added to the Actor.
   * @param {boolean} [prompt=true] - Whether or not to prompt the user.
   * @returns {Promise<Item5e[]>}
   */
  async addEmbeddedItems(items, prompt=true) {
    let itemsToAdd = items;
    if ( !items.length ) return [];

    // Obtain the array of item creation data
    let toCreate = [];
    if (prompt) {
      const itemIdsToAdd = await SelectItemsPrompt.create(items, {
        hint: game.i18n.localize('SW5E.AddEmbeddedItemPromptHint')
      });
      for (let item of items) {
        if (itemIdsToAdd.includes(item.id)) toCreate.push(item.toObject());
      }
    } else {
      toCreate = items.map(item => item.toObject());
    }

    // Create the requested items
    if (itemsToAdd.length === 0) return [];
    return Item5e.createDocuments(toCreate, {parent: this});
  }

  /* -------------------------------------------- */

  /**
   * Get a list of features to add to the Actor when a class item is updated.
   * Optionally prompt the user for which they would like to add.
   */
  async getClassFeatures({className, archetypeName, level}={}) {
    const existing = new Set(this.items.map(i => i.name));
    const features = await Actor5e.loadClassFeatures({className, archetypeName, level});
    return features.filter(f => !existing.has(f.name)) || [];
  }

  /* -------------------------------------------- */

  /**
   * Return the features which a character is awarded for each class level
   * @param {string} className        The class name being added
   * @param {string} archetypeName     The archetype of the class being added, if any
   * @param {number} level            The number of levels in the added class
   * @param {number} priorLevel       The previous level of the added class
   * @return {Promise<Item5e[]>}     Array of Item5e entities
   */
  static async loadClassFeatures({className="", archetypeName="", level=1, priorLevel=0}={}) {
    className = className.toLowerCase();
    archetypeName = archetypeName.slugify();

    // Get the configuration of features which may be added
    const clsConfig = CONFIG.SW5E.classFeatures[className];
    if (!clsConfig) return [];

    // Acquire class features
    let ids = [];
    for ( let [l, f] of Object.entries(clsConfig.features || {}) ) {
      l = parseInt(l);
      if ( (l <= level) && (l > priorLevel) ) ids = ids.concat(f);
    }

    // Acquire archetype features
    const archConfig = clsConfig.archetypes[archetypeName] || {};
    for ( let [l, f] of Object.entries(archConfig.features || {}) ) {
      l = parseInt(l);
      if ( (l <= level) && (l > priorLevel) ) ids = ids.concat(f);
    }

    // Load item data for all identified features
    const features = [];
    for ( let id of ids ) {
      features.push(await fromUuid(id));
    }

    // Class powers should always be prepared
    for ( const feature of features ) {
      if ( feature.type === "power" ) {
        const preparation = feature.data.data.preparation;
        preparation.mode = "always";
        preparation.prepared = true;
      }
    }
    return features;
  }

  /* -------------------------------------------- */
  /*  Data Preparation Helpers                    */
  /* -------------------------------------------- */

  /**
   * Prepare Character type specific data
   */
  _prepareCharacterData(actorData) {
    const data = actorData.data;

    // Determine character level and available hit dice based on owned Class items
    const [level, hd] = this.items.reduce((arr, item) => {
      if ( item.type === "class" ) {
        const classLevels = parseInt(item.data.data.levels) || 1;
        arr[0] += classLevels;
        arr[1] += classLevels - (parseInt(item.data.data.hitDiceUsed) || 0);
      }
      return arr;
    }, [0, 0]);
    data.details.level = level;
    data.attributes.hd = hd;

    // Character proficiency bonus
    data.attributes.prof = Math.floor((level + 7) / 4);

    // Experience required for next level
    const xp = data.details.xp;
    xp.max = this.getLevelExp(level || 1);
    const prior = this.getLevelExp(level - 1 || 0);
    const required = xp.max - prior;
    const pct = Math.round((xp.value - prior) * 100 / required);
    xp.pct = Math.clamped(pct, 0, 100);
  }

  /* -------------------------------------------- */

  /**
   * Prepare NPC type specific data
   */
  _prepareNPCData(actorData) {
    const data = actorData.data;

    // Kill Experience
    data.details.xp.value = this.getCRExp(data.details.cr);

    // Proficiency
    data.attributes.prof = Math.floor((Math.max(data.details.cr, 1) + 7) / 4);

    // Powercaster Level
    if ( data.attributes.powercasting && !Number.isNumeric(data.details.powerLevel) ) {
      data.details.powerLevel = Math.max(data.details.cr, 1);
    }
  }

  /* -------------------------------------------- */

  /**
   * Prepare vehicle type-specific data
   * @param actorData
   * @private
   */
  _prepareVehicleData(actorData) {}

  /* -------------------------------------------- */

  /**
   * Prepare starship type-specific data
   * @param actorData
   * @private
   */
  _prepareStarshipData(actorData) {
    const data = actorData.data;

    // Proficiency
    data.attributes.prof = Math.floor((Math.max(data.details.tier, 1) + 7) / 4);

    // Link hull to hp and shields to temp hp
    data.attributes.hull.value = data.attributes.hp.value;
    data.attributes.hull.max = data.attributes.hp.max;
    data.attributes.shld.value = data.attributes.hp.temp;
    data.attributes.shld.max = data.attributes.hp.tempmax;
  }

  /* -------------------------------------------- */

  /**
   * Prepare skill checks.
   * @param actorData
   * @param bonuses Global bonus data.
   * @param checkBonus Ability check specific bonus.
   * @param originalSkills A transformed actor's original actor's skills.
   * @private
   */
  _prepareSkills(actorData, bonuses, checkBonus, originalSkills) {
    if (actorData.type === 'vehicle') return;

    const data = actorData.data;
    const flags = actorData.flags.sw5e || {};

    // Skill modifiers
    const feats = SW5E.characterFlags;
    const athlete = flags.remarkableAthlete;
    const joat = flags.jackOfAllTrades;
    const observant = flags.observantFeat;
    const skillBonus = Number.isNumeric(bonuses.skill) ? parseInt(bonuses.skill) :  0;
    for (let [id, skl] of Object.entries(data.skills)) {
      skl.value = Math.clamped(Number(skl.value).toNearest(0.5), 0, 2) ?? 0;
      let round = Math.floor;

      // Remarkable
      if ( athlete && (skl.value < 0.5) && feats.remarkableAthlete.abilities.includes(skl.ability) ) {
        skl.value = 0.5;
        round = Math.ceil;
      }

      // Jack of All Trades
      if ( joat && (skl.value < 0.5) ) {
        skl.value = 0.5;
      }

      // Polymorph Skill Proficiencies
      if ( originalSkills ) {
        skl.value = Math.max(skl.value, originalSkills[id].value);
      }

      // Compute modifier
      skl.bonus = checkBonus + skillBonus;
      skl.mod = data.abilities[skl.ability].mod;
      skl.prof = round(skl.value * data.attributes.prof);
      skl.total = skl.mod + skl.prof + skl.bonus;

      // Compute passive bonus
      const passive = observant && (feats.observantFeat.skills.includes(id)) ? 5 : 0;
      skl.passive = 10 + skl.total + passive;
    }
  }

  /* -------------------------------------------- */

  /**
   * Prepare data related to the power-casting capabilities of the Actor
   * @private
   */
  _computePowercastingProgression (actorData) {
    if (actorData.type === 'vehicle' || actorData.type === 'starship') return;
    const ad = actorData.data;
    const powers = ad.powers;
    const isNPC = actorData.type === 'npc';

    // Powercasting DC
    // TODO: Consider an option for using the variant rule of all powers use the same value
    ad.attributes.powerForceLightDC = 8 + ad.abilities.wis.mod + ad.attributes.prof ?? 10;
    ad.attributes.powerForceDarkDC = 8 + ad.abilities.cha.mod + ad.attributes.prof ?? 10;
    ad.attributes.powerForceUnivDC = Math.max(ad.attributes.powerForceLightDC,ad.attributes.powerForceDarkDC) ?? 10
    ad.attributes.powerTechDC = 8 + ad.abilities.int.mod + ad.attributes.prof ?? 10;

    // Translate the list of classes into force and tech power-casting progression
    const forceProgression = {
      classes: 0,
      levels: 0,
      multi: 0,
      maxClass: "none",
      maxClassPriority: 0,
      maxClassLevels: 0,
      maxClassPowerLevel: 0,
      powersKnown: 0,
      points: 0
    };
    const techProgression = {
      classes: 0,
      levels: 0,
      multi: 0,
      maxClass: "none",
      maxClassPriority: 0,
      maxClassLevels: 0,
      maxClassPowerLevel: 0,
      powersKnown: 0,
      points: 0
    };

    // Tabulate the total power-casting progression
    const classes = this.data.items.filter(i => i.type === "class");
    let priority = 0;
    for ( let cls of classes ) {
      const d = cls.data.data;
      if ( d.powercasting.progression === "none" ) continue;
      const levels = d.levels;
      const prog = d.powercasting.progression;
      // TODO: Consider a more dynamic system
      switch (prog) {
        case 'consular': 
          priority = 3;
          forceProgression.levels += levels;
          forceProgression.multi += (SW5E.powerMaxLevel['consular'][19]/9)*levels;
          forceProgression.classes++;
          // see if class controls high level forcecasting
          if ((levels >= forceProgression.maxClassLevels) && (priority > forceProgression.maxClassPriority)){
            forceProgression.maxClass = 'consular';
            forceProgression.maxClassLevels = levels;
            forceProgression.maxClassPriority = priority;
            forceProgression.maxClassPowerLevel = SW5E.powerMaxLevel['consular'][Math.clamped((levels - 1), 0, 20)];
          }
          // calculate points and powers known
          forceProgression.powersKnown += SW5E.powersKnown['consular'][Math.clamped((levels - 1), 0, 20)];
          forceProgression.points += SW5E.powerPoints['consular'][Math.clamped((levels - 1), 0, 20)];
          break;
        case 'engineer': 
          priority = 2
          techProgression.levels += levels;
          techProgression.multi += (SW5E.powerMaxLevel['engineer'][19]/9)*levels;
          techProgression.classes++;
          // see if class controls high level techcasting
          if ((levels >= techProgression.maxClassLevels) && (priority > techProgression.maxClassPriority)){
            techProgression.maxClass = 'engineer';
            techProgression.maxClassLevels = levels;
            techProgression.maxClassPriority = priority;
            techProgression.maxClassPowerLevel = SW5E.powerMaxLevel['engineer'][Math.clamped((levels - 1), 0, 20)];
          }
          techProgression.powersKnown += SW5E.powersKnown['engineer'][Math.clamped((levels - 1), 0, 20)];
          techProgression.points += SW5E.powerPoints['engineer'][Math.clamped((levels - 1), 0, 20)];
          break;
        case 'guardian': 
          priority = 1;
          forceProgression.levels += levels;
          forceProgression.multi += (SW5E.powerMaxLevel['guardian'][19]/9)*levels;
          forceProgression.classes++;
          // see if class controls high level forcecasting
          if ((levels >= forceProgression.maxClassLevels) && (priority > forceProgression.maxClassPriority)){
            forceProgression.maxClass = 'guardian';
            forceProgression.maxClassLevels = levels;
            forceProgression.maxClassPriority = priority;
            forceProgression.maxClassPowerLevel = SW5E.powerMaxLevel['guardian'][Math.clamped((levels - 1), 0, 20)];
          }
          forceProgression.powersKnown += SW5E.powersKnown['guardian'][Math.clamped((levels - 1), 0, 20)];
          forceProgression.points += SW5E.powerPoints['guardian'][Math.clamped((levels - 1), 0, 20)];
          break;
        case 'scout': 
          priority = 1;
          techProgression.levels += levels;
          techProgression.multi += (SW5E.powerMaxLevel['scout'][19]/9)*levels;
          techProgression.classes++;
          // see if class controls high level techcasting
          if ((levels >= techProgression.maxClassLevels) && (priority > techProgression.maxClassPriority)){
            techProgression.maxClass = 'scout';
            techProgression.maxClassLevels = levels;
            techProgression.maxClassPriority = priority;
            techProgression.maxClassPowerLevel = SW5E.powerMaxLevel['scout'][Math.clamped((levels - 1), 0, 20)];
          }
          techProgression.powersKnown += SW5E.powersKnown['scout'][Math.clamped((levels - 1), 0, 20)];
          techProgression.points += SW5E.powerPoints['scout'][Math.clamped((levels - 1), 0, 20)];
          break;
        case 'sentinel': 
          priority = 2;
          forceProgression.levels += levels;
          forceProgression.multi += (SW5E.powerMaxLevel['sentinel'][19]/9)*levels;
          forceProgression.classes++;
          // see if class controls high level forcecasting
          if ((levels >= forceProgression.maxClassLevels) && (priority > forceProgression.maxClassPriority)){
            forceProgression.maxClass = 'sentinel';
            forceProgression.maxClassLevels = levels;
            forceProgression.maxClassPriority = priority;
            forceProgression.maxClassPowerLevel = SW5E.powerMaxLevel['sentinel'][Math.clamped((levels - 1), 0, 20)];
          }
          forceProgression.powersKnown += SW5E.powersKnown['sentinel'][Math.clamped((levels - 1), 0, 20)];
          forceProgression.points += SW5E.powerPoints['sentinel'][Math.clamped((levels - 1), 0, 20)];
          break;      }
    }

    if (isNPC) {
      // EXCEPTION: NPC with an explicit power-caster level
      if (ad.details.powerForceLevel) {
        forceProgression.levels = ad.details.powerForceLevel;
        ad.attributes.force.level = forceProgression.levels;
        forceProgression.maxClass = ad.attributes.powercasting;
        forceProgression.maxClassPowerLevel = SW5E.powerMaxLevel[forceProgression.maxClass][Math.clamped((forceProgression.levels - 1), 0, 20)];
      }
      if (ad.details.powerTechLevel) {
        techProgression.levels = ad.details.powerTechLevel;
        ad.attributes.tech.level = techProgression.levels;
        techProgression.maxClass = ad.attributes.powercasting;
        techProgression.maxClassPowerLevel = SW5E.powerMaxLevel[techProgression.maxClass][Math.clamped((techProgression.levels - 1), 0, 20)];
      }
    } else {
      // EXCEPTION: multi-classed progression uses multi rounded down rather than levels
      if (forceProgression.classes > 1) {
        forceProgression.levels = Math.floor(forceProgression.multi);
        forceProgression.maxClassPowerLevel = SW5E.powerMaxLevel['multi'][forceProgression.levels - 1];
      }
      if (techProgression.classes > 1) {
        techProgression.levels = Math.floor(techProgression.multi);
        techProgression.maxClassPowerLevel = SW5E.powerMaxLevel['multi'][techProgression.levels - 1];
      }
    }


    // Look up the number of slots per level from the powerLimit table
    let forcePowerLimit = Array.from(SW5E.powerLimit['none']);
    for (let i = 0; i < (forceProgression.maxClassPowerLevel); i++) {
      forcePowerLimit[i] = SW5E.powerLimit[forceProgression.maxClass][i];
    }

    for ( let [n, lvl] of Object.entries(powers) ) {
      let i = parseInt(n.slice(-1));
      if ( Number.isNaN(i) ) continue;
      if ( Number.isNumeric(lvl.foverride) ) lvl.fmax = Math.max(parseInt(lvl.foverride), 0);
      else lvl.fmax = forcePowerLimit[i-1] || 0;
      if (isNPC){
        lvl.fvalue = lvl.fmax; 
      }else{
        lvl.fvalue = Math.min(parseInt(lvl.fvalue || lvl.value || lvl.fmax),lvl.fmax);
      }
    }
    
    let techPowerLimit = Array.from(SW5E.powerLimit['none']);
    for (let i = 0; i < (techProgression.maxClassPowerLevel); i++) {
      techPowerLimit[i] = SW5E.powerLimit[techProgression.maxClass][i];
    }

    for ( let [n, lvl] of Object.entries(powers) ) {
      let i = parseInt(n.slice(-1));
      if ( Number.isNaN(i) ) continue;
      if ( Number.isNumeric(lvl.toverride) ) lvl.tmax = Math.max(parseInt(lvl.toverride), 0);
      else lvl.tmax = techPowerLimit[i-1] || 0;
      if (isNPC){
        lvl.tvalue = lvl.tmax;
      }else{
        lvl.tvalue = Math.min(parseInt(lvl.tvalue || lvl.value || lvl.tmax),lvl.tmax);
      }
    }

    // Set Force and tech power for PC Actors
    if (!isNPC) {
      if (forceProgression.levels) {
        ad.attributes.force.known.max = forceProgression.powersKnown;
        ad.attributes.force.points.max = forceProgression.points + Math.max(ad.abilities.wis.mod, ad.abilities.cha.mod);
        ad.attributes.force.level = forceProgression.levels;
      }
      if (techProgression.levels){
        ad.attributes.tech.known.max = techProgression.powersKnown;
        ad.attributes.tech.points.max = techProgression.points + ad.abilities.int.mod;
        ad.attributes.tech.level = techProgression.levels;
      }
    }


    // Tally Powers Known and check for migration first to avoid errors
    let hasKnownPowers = actorData?.data?.attributes?.force?.known?.value !== undefined;
    if ( hasKnownPowers ) {
      const knownPowers = this.data.items.filter(i => i.type === "power");
      let knownForcePowers = 0;
      let knownTechPowers = 0;
      for ( let knownPower of knownPowers ) {
        const d = knownPower.data;
        switch (knownPower.data.school){
          case "lgt":
          case "uni":
          case "drk":{
            knownForcePowers++;
            break;
          }
          case "tec":{
            knownTechPowers++;
            break;
          }
        }
      }
      ad.attributes.force.known.value = knownForcePowers;
      ad.attributes.tech.known.value = knownTechPowers;
    }
  }

  /* -------------------------------------------- */

  /**
   * Compute the level and percentage of encumbrance for an Actor.
   *
   * Optionally include the weight of carried currency across all denominations by applying the standard rule
   * from the PHB pg. 143
   * @param {Object} actorData      The data object for the Actor being rendered
   * @returns {{max: number, value: number, pct: number}}  An object describing the character's encumbrance level
   * @private
   */
  _computeEncumbrance(actorData) {
    // TODO: Maybe add an option for variant encumbrance
    // Get the total weight from items
    const physicalItems = ["weapon", "equipment", "consumable", "tool", "backpack", "loot"];
    let weight = actorData.items.reduce((weight, i) => {
      if ( !physicalItems.includes(i.type) ) return weight;
      const q = i.data.data.quantity || 0;
      const w = i.data.data.weight || 0;
      return weight + (q * w);
    }, 0);

    // [Optional] add Currency Weight (for non-transformed actors)
    if ( game.settings.get("sw5e", "currencyWeight") && actorData.data.currency ) {
      const currency = actorData.data.currency;
      const numCoins = Object.values(currency).reduce((val, denom) => val += Math.max(denom, 0), 0);
      weight += numCoins / CONFIG.SW5E.encumbrance.currencyPerWeight;
    }

    // Determine the encumbrance size class
    let mod = {
      tiny: 0.5,
      sm: 1,
      med: 1,
      lg: 2,
      huge: 4,
      grg: 8
    }[actorData.data.traits.size] || 1;
    if ( this.getFlag("sw5e", "powerfulBuild") ) mod = Math.min(mod * 2, 8);

    // Compute Encumbrance percentage
    weight = weight.toNearest(0.1);
    const max = actorData.data.abilities.str.value * CONFIG.SW5E.encumbrance.strMultiplier * mod;
    const pct = Math.clamped((weight * 100) / max, 0, 100);
    return { value: weight.toNearest(0.1), max, pct, encumbered: pct > (2/3) };
  }

  /* -------------------------------------------- */
  /*  Event Handlers                              */
  /* -------------------------------------------- */

  /** @inheritdoc */
  async _preCreate(data, options, user) {
    await super._preCreate(data, options, user);

    // Token size category
    const s = CONFIG.SW5E.tokenSizes[this.data.data.traits.size || "med"];
    this.data.token.update({width: s, height: s});

    // Player character configuration
    if ( this.type === "character" ) {
      this.data.token.update({vision: true, actorLink: true, disposition: 1});
    }
  }

  /* -------------------------------------------- */

  /** @inheritdoc */
  async _preUpdate(changed, options, user) {
    await super._preUpdate(changed, options, user);

    // Apply changes in Actor size to Token width/height
    const newSize = foundry.utils.getProperty(changed, "data.traits.size");
    if ( newSize && (newSize !== foundry.utils.getProperty(this.data, "data.traits.size")) ) {
      let size = CONFIG.SW5E.tokenSizes[newSize];
      if ( !foundry.utils.hasProperty(changed, "token.width") ) {
        changed.token = changed.token || {};
        changed.token.height = size;
        changed.token.width = size;
      }
    }

    // Reset death save counters
    const isDead = this.data.data.attributes.hp.value <= 0;
    if ( isDead && (foundry.utils.getProperty(changed, "data.attributes.hp.value") > 0) ) {
      foundry.utils.setProperty(changed, "data.attributes.death.success", 0);
      foundry.utils.setProperty(changed, "data.attributes.death.failure", 0);
    }
  }

  /* -------------------------------------------- */

  /**
   * Assign a class item as the original class for the Actor based on which class has the most levels
   * @protected
   */
  _assignPrimaryClass() {
    const classes = this.itemTypes.class.sort((a, b) => b.data.data.levels - a.data.data.levels);
    const newPC = classes[0]?.id || "";
    return this.update({"data.details.originalClass": newPC});
  }

  /* -------------------------------------------- */
  /*  Gameplay Mechanics                          */
  /* -------------------------------------------- */

  /** @override */
  async modifyTokenAttribute(attribute, value, isDelta, isBar) {
    if ( attribute === "attributes.hp" ) {
      const hp = getProperty(this.data.data, attribute);
      const delta = isDelta ? (-1 * value) : (hp.value + hp.temp) - value;
      return this.applyDamage(delta);
    }
    return super.modifyTokenAttribute(attribute, value, isDelta, isBar);
  }

  /* -------------------------------------------- */

  /**
   * Apply a certain amount of damage or healing to the health pool for Actor
   * @param {number} amount       An amount of damage (positive) or healing (negative) to sustain
   * @param {number} multiplier   A multiplier which allows for resistance, vulnerability, or healing
   * @return {Promise<Actor>}     A Promise which resolves once the damage has been applied
   */
  async applyDamage(amount=0, multiplier=1) {
    amount = Math.floor(parseInt(amount) * multiplier);
    const hp = this.data.data.attributes.hp;

    // Deduct damage from temp HP first
    const tmp = parseInt(hp.temp) || 0;
    const dt = amount > 0 ? Math.min(tmp, amount) : 0;

    // Remaining goes to health
    const tmpMax = parseInt(hp.tempmax) || 0;
    const dh = Math.clamped(hp.value - (amount - dt), 0, hp.max + tmpMax);

    // Update the Actor
    const updates = {
      "data.attributes.hp.temp": tmp - dt,
      "data.attributes.hp.value": dh
    };

    // Delegate damage application to a hook
    // TODO replace this in the future with a better modifyTokenAttribute function in the core
    const allowed = Hooks.call("modifyTokenAttribute", {
      attribute: "attributes.hp",
      value: amount,
      isDelta: false,
      isBar: true
    }, updates);
    return allowed !== false ? this.update(updates) : this;
  }

  /* -------------------------------------------- */

  /**
   * Roll a Skill Check
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param {string} skillId      The skill id (e.g. "ins")
   * @param {Object} options      Options which configure how the skill check is rolled
   * @return {Promise<Roll>}      A Promise which resolves to the created Roll instance
   */
  rollSkill(skillId, options={}) {
    const skl = this.data.data.skills[skillId];
    const bonuses = getProperty(this.data.data, "bonuses.abilities") || {};

    // Compose roll parts and data
    const parts = ["@mod"];
    const data = {mod: skl.mod + skl.prof};

    // Ability test bonus
    if ( bonuses.check ) {
      data["checkBonus"] = bonuses.check;
      parts.push("@checkBonus");
    }

    // Skill check bonus
    if ( bonuses.skill ) {
      data["skillBonus"] = bonuses.skill;
      parts.push("@skillBonus");
    }

    // Add provided extra roll parts now because they will get clobbered by mergeObject below
    if (options.parts?.length > 0) {
      parts.push(...options.parts);
    }

    // Reliable Talent applies to any skill check we have full or better proficiency in
    const reliableTalent = (skl.value >= 1 && this.getFlag("sw5e", "reliableTalent"));

    // Roll and return
    const rollData = foundry.utils.mergeObject(options, {
      parts: parts,
      data: data,
      title: game.i18n.format("SW5E.SkillPromptTitle", {skill: CONFIG.SW5E.skills[skillId] || CONFIG.SW5E.starshipSkills[skillId]}),
      halflingLucky: this.getFlag("sw5e", "halflingLucky"),
      reliableTalent: reliableTalent,
      messageData: {
        speaker: options.speaker || ChatMessage.getSpeaker({actor: this}),
        "flags.sw5e.roll": {type: "skill", skillId }
      }
    });
    return d20Roll(rollData);
  }

  /* -------------------------------------------- */

  /**
   * Roll a generic ability test or saving throw.
   * Prompt the user for input on which variety of roll they want to do.
   * @param {String}abilityId     The ability id (e.g. "str")
   * @param {Object} options      Options which configure how ability tests or saving throws are rolled
   */
  rollAbility(abilityId, options={}) {
    const label = CONFIG.SW5E.abilities[abilityId];
    new Dialog({
      title: game.i18n.format("SW5E.AbilityPromptTitle", {ability: label}),
      content: `<p>${game.i18n.format("SW5E.AbilityPromptText", {ability: label})}</p>`,
      buttons: {
        test: {
          label: game.i18n.localize("SW5E.ActionAbil"),
          callback: () => this.rollAbilityTest(abilityId, options)
        },
        save: {
          label: game.i18n.localize("SW5E.ActionSave"),
          callback: () => this.rollAbilitySave(abilityId, options)
        }
      }
    }).render(true);
  }

  /* -------------------------------------------- */

  /**
   * Roll an Ability Test
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param {String} abilityId    The ability ID (e.g. "str")
   * @param {Object} options      Options which configure how ability tests are rolled
   * @return {Promise<Roll>}      A Promise which resolves to the created Roll instance
   */
  rollAbilityTest(abilityId, options={}) {
    const label = CONFIG.SW5E.abilities[abilityId];
    const abl = this.data.data.abilities[abilityId];

    // Construct parts
    const parts = ["@mod"];
    const data = {mod: abl.mod};

    // Add feat-related proficiency bonuses
    const feats = this.data.flags.sw5e || {};
    if ( feats.remarkableAthlete && SW5E.characterFlags.remarkableAthlete.abilities.includes(abilityId) ) {
      parts.push("@proficiency");
      data.proficiency = Math.ceil(0.5 * this.data.data.attributes.prof);
    }
    else if ( feats.jackOfAllTrades ) {
      parts.push("@proficiency");
      data.proficiency = Math.floor(0.5 * this.data.data.attributes.prof);
    }

    // Add global actor bonus
    const bonuses = getProperty(this.data.data, "bonuses.abilities") || {};
    if ( bonuses.check ) {
      parts.push("@checkBonus");
      data.checkBonus = bonuses.check;
    }

    // Add provided extra roll parts now because they will get clobbered by mergeObject below
    if (options.parts?.length > 0) {
      parts.push(...options.parts);
    }

    // Roll and return
    const rollData = foundry.utils.mergeObject(options, {
      parts: parts,
      data: data,
      title: game.i18n.format("SW5E.AbilityPromptTitle", {ability: label}),
      halflingLucky: feats.halflingLucky,
      messageData: {
        speaker: options.speaker || ChatMessage.getSpeaker({actor: this}),
        "flags.sw5e.roll": {type: "ability", abilityId }
      }
    });
    return d20Roll(rollData);
  }

  /* -------------------------------------------- */

  /**
   * Roll an Ability Saving Throw
   * Prompt the user for input regarding Advantage/Disadvantage and any Situational Bonus
   * @param {String} abilityId    The ability ID (e.g. "str")
   * @param {Object} options      Options which configure how ability tests are rolled
   * @return {Promise<Roll>}      A Promise which resolves to the created Roll instance
   */
  rollAbilitySave(abilityId, options={}) {
    const label = CONFIG.SW5E.abilities[abilityId];
    const abl = this.data.data.abilities[abilityId];

    // Construct parts
    const parts = ["@mod"];
    const data = {mod: abl.mod};

    // Include proficiency bonus
    if ( abl.prof > 0 ) {
      parts.push("@prof");
      data.prof = abl.prof;
    }

    // Include a global actor ability save bonus
    const bonuses = getProperty(this.data.data, "bonuses.abilities") || {};
    if ( bonuses.save ) {
      parts.push("@saveBonus");
      data.saveBonus = bonuses.save;
    }

    // Add provided extra roll parts now because they will get clobbered by mergeObject below
    if (options.parts?.length > 0) {
      parts.push(...options.parts);
    }

    // Roll and return
    const rollData = foundry.utils.mergeObject(options, {
      parts: parts,
      data: data,
      title: game.i18n.format("SW5E.SavePromptTitle", {ability: label}),
      halflingLucky: this.getFlag("sw5e", "halflingLucky"),
      messageData: {
        speaker: options.speaker || ChatMessage.getSpeaker({actor: this}),
        "flags.sw5e.roll": {type: "save", abilityId }
      }
    });
    return d20Roll(rollData);
  }

  /* -------------------------------------------- */

  /**
   * Perform a death saving throw, rolling a d20 plus any global save bonuses
   * @param {Object} options        Additional options which modify the roll
   * @return {Promise<Roll|null>}   A Promise which resolves to the Roll instance
   */
  async rollDeathSave(options={}) {

    // Display a warning if we are not at zero HP or if we already have reached 3
    const death = this.data.data.attributes.death;
    if ( (this.data.data.attributes.hp.value > 0) || (death.failure >= 3) || (death.success >= 3)) {
      ui.notifications.warn(game.i18n.localize("SW5E.DeathSaveUnnecessary"));
      return null;
    }

    // Evaluate a global saving throw bonus
    const parts = [];
    const data = {};

    // Include a global actor ability save bonus
    const bonuses = foundry.utils.getProperty(this.data.data, "bonuses.abilities") || {};
    if ( bonuses.save ) {
      parts.push("@saveBonus");
      data.saveBonus = bonuses.save;
    }

    // Evaluate the roll
    const rollData = foundry.utils.mergeObject(options, {
      parts: parts,
      data: data,
      title: game.i18n.localize("SW5E.DeathSavingThrow"),
      halflingLucky: this.getFlag("sw5e", "halflingLucky"),
      targetValue: 10,
      messageData: {
        speaker: options.speaker || ChatMessage.getSpeaker({actor: this}),
        "flags.sw5e.roll": {type: "death"}
      }
    });
    const roll = await d20Roll(rollData);
    if ( !roll ) return null;

    // Take action depending on the result
    const success = roll.total >= 10;
    const d20 = roll.dice[0].total;

    let chatString;

    // Save success
    if ( success ) {
      let successes = (death.success || 0) + 1;

      // Critical Success = revive with 1hp
      if ( d20 === 20 ) {
        await this.update({
          "data.attributes.death.success": 0,
          "data.attributes.death.failure": 0,
          "data.attributes.hp.value": 1
        });
        chatString = "SW5E.DeathSaveCriticalSuccess";
      }

      // 3 Successes = survive and reset checks
      else if ( successes === 3 ) {
        await this.update({
          "data.attributes.death.success": 0,
          "data.attributes.death.failure": 0
        });
        chatString = "SW5E.DeathSaveSuccess";
      }

      // Increment successes
      else await this.update({"data.attributes.death.success": Math.clamped(successes, 0, 3)});
    }

    // Save failure
    else {
      let failures = (death.failure || 0) + (d20 === 1 ? 2 : 1);
      await this.update({"data.attributes.death.failure": Math.clamped(failures, 0, 3)});
      if ( failures >= 3 ) {  // 3 Failures = death
        chatString = "SW5E.DeathSaveFailure";
      }
    }

    // Display success/failure chat message
    if ( chatString ) {
      let chatData = { content: game.i18n.format(chatString, {name: this.name}), speaker };
      ChatMessage.applyRollMode(chatData, roll.options.rollMode);
      await ChatMessage.create(chatData);
    }

    // Return the rolled result
    return roll;
  }

  /* -------------------------------------------- */

  /**
   * Roll a hit die of the appropriate type, gaining hit points equal to the die roll plus your CON modifier
   * @param {string} [denomination]   The hit denomination of hit die to roll. Example "d8".
   *                                  If no denomination is provided, the first available HD will be used
   * @param {boolean} [dialog]        Show a dialog prompt for configuring the hit die roll?
   * @return {Promise<Roll|null>}     The created Roll instance, or null if no hit die was rolled
   */
  async rollHitDie(denomination, {dialog=true}={}) {

    // If no denomination was provided, choose the first available
    let cls = null;
    if ( !denomination ) {
      cls = this.itemTypes.class.find(c => c.data.data.hitDiceUsed < c.data.data.levels);
      if ( !cls ) return null;
      denomination = cls.data.data.hitDice;
    }

    // Otherwise locate a class (if any) which has an available hit die of the requested denomination
    else {
      cls = this.items.find(i => {
        const d = i.data.data;
        return (d.hitDice === denomination) && ((d.hitDiceUsed || 0) < (d.levels || 1));
      });
    }

    // If no class is available, display an error notification
    if ( !cls ) {
      ui.notifications.error(game.i18n.format("SW5E.HitDiceWarn", {name: this.name, formula: denomination}));
      return null;
    }

    // Prepare roll data
    const parts = [`1${denomination}`, "@abilities.con.mod"];
    const title = game.i18n.localize("SW5E.HitDiceRoll");
    const rollData = foundry.utils.deepClone(this.data.data);

    // Call the roll helper utility
    const roll = await damageRoll({
      event: new Event("hitDie"),
      parts: parts,
      data: rollData,
      title: title,
      allowCritical: false,
      fastForward: !dialog,
      dialogOptions: {width: 350},
      messageData: {
        speaker: ChatMessage.getSpeaker({actor: this}),
        "flags.sw5e.roll": {type: "hitDie"}
      }
    });
    if ( !roll ) return null;

    // Adjust actor data
    await cls.update({"data.hitDiceUsed": cls.data.data.hitDiceUsed + 1});
    const hp = this.data.data.attributes.hp;
    const dhp = Math.min(hp.max + (hp.tempmax ?? 0) - hp.value, roll.total);
    await this.update({"data.attributes.hp.value": hp.value + dhp});
    return roll;
  }

  /* -------------------------------------------- */

  /**
   * Results from a rest operation.
   *
   * @typedef {object} RestResult
   * @property {number} dhp                  Hit points recovered during the rest.
   * @property {number} dhd                  Hit dice recovered or spent during the rest.
   * @property {object} updateData           Updates applied to the actor.
   * @property {Array.<object>} updateItems  Updates applied to actor's items.
   * @property {boolean} newDay              Whether a new day occurred during the rest.
   */

  /* -------------------------------------------- */

  /**
   * Take a short rest, possibly spending hit dice and recovering resources, item uses, and tech slots & points.
   *
   * @param {object} [options]
   * @param {boolean} [options.dialog=true]         Present a dialog window which allows for rolling hit dice as part
   *                                                of the Short Rest and selecting whether a new day has occurred.
   * @param {boolean} [options.chat=true]           Summarize the results of the rest workflow as a chat message.
   * @param {boolean} [options.autoHD=false]        Automatically spend Hit Dice if you are missing 3 or more hit points.
   * @param {boolean} [options.autoHDThreshold=3]   A number of missing hit points which would trigger an automatic HD roll.
   * @return {Promise.<RestResult>}                 A Promise which resolves once the short rest workflow has completed.
   */
  async shortRest({dialog=true, chat=true, autoHD=false, autoHDThreshold=3}={}) {

    // Take note of the initial hit points and number of hit dice the Actor has
    const hd0 = this.data.data.attributes.hd;
    const hp0 = this.data.data.attributes.hp.value;
    let newDay = false;

    // Display a Dialog for rolling hit dice
    if ( dialog ) {
      try {
        newDay = await ShortRestDialog.shortRestDialog({actor: this, canRoll: hd0 > 0});
      } catch(err) {
        return;
      }
    }

    // Automatically spend hit dice
    else if ( autoHD ) {
      await this.autoSpendHitDice({ threshold: autoHDThreshold });
    }

    return this._rest(chat, newDay, false, this.data.data.attributes.hd - hd0, this.data.data.attributes.hp.value - hp0, this.data.data.attributes.tech.points.max - this.data.data.attributes.tech.points.value);
  }

  /* -------------------------------------------- */

  /**
   * Take a long rest, recovering hit points, hit dice, resources, item uses, and tech & force power points & slots.
   *
   * @param {object} [options]
   * @param {boolean} [options.dialog=true]  Present a confirmation dialog window whether or not to take a long rest.
   * @param {boolean} [options.chat=true]    Summarize the results of the rest workflow as a chat message.
   * @param {boolean} [options.newDay=true]  Whether the long rest carries over to a new day.
   * @return {Promise.<RestResult>}          A Promise which resolves once the long rest workflow has completed.
   */
  async longRest({dialog=true, chat=true, newDay=true}={}) {
    // Maybe present a confirmation dialog
    if ( dialog ) {
      try {
        newDay = await LongRestDialog.longRestDialog({actor: this});
      } catch(err) {
        return;
      }
    }

    return this._rest(chat, newDay, true, 0, 0, this.data.data.attributes.tech.points.max - this.data.data.attributes.tech.points.value, this.data.data.attributes.force.points.max - this.data.data.attributes.force.points.value);
  }

  /* -------------------------------------------- */

  /**
   * Perform all of the changes needed for a short or long rest.
   *
   * @param {boolean} chat           Summarize the results of the rest workflow as a chat message.
   * @param {boolean} newDay         Has a new day occurred during this rest?
   * @param {boolean} longRest       Is this a long rest?
   * @param {number} [dhd=0]         Number of hit dice spent during so far during the rest.
   * @param {number} [dhp=0]         Number of hit points recovered so far during the rest.
   * @param {number} [dtp=0]         Number of tech points recovered so far during the rest.
   * @param {number} [dfp=0]         Number of force points recovered so far during the rest.
   * @return {Promise.<RestResult>}  Consolidated results of the rest workflow.
   * @private
   */
  async _rest(chat, newDay, longRest, dhd=0, dhp=0, dtp=0, dfp=0) {
    // TODO: Turn gritty realism into the SW5e longer rests variant rule https://sw5e.com/rules/variantRules/Longer%20Rests
    let hitPointsRecovered = 0;
    let hitPointUpdates = {};
    let hitDiceRecovered = 0;
    let hitDiceUpdates = [];

    // Recover hit points & hit dice on long rest
    if ( longRest ) {
      ({ updates: hitPointUpdates, hitPointsRecovered } = this._getRestHitPointRecovery());
      ({ updates: hitDiceUpdates, hitDiceRecovered } = this._getRestHitDiceRecovery());
    }

    // Figure out the rest of the changes
    const result = {
      dhd: dhd + hitDiceRecovered,
      dhp: dhp + hitPointsRecovered,
      dtp: dtp,
      dfp: dfp,
      updateData: {
        ...hitPointUpdates,
        ...this._getRestResourceRecovery({ recoverShortRestResources: !longRest, recoverLongRestResources: longRest }),
        ...this._getRestPowerRecovery({ recoverForcePowers: longRest })
      },
      updateItems: [
        ...hitDiceUpdates,
        ...this._getRestItemUsesRecovery({ recoverLongRestUses: longRest, recoverDailyUses: newDay })
      ],
      newDay: newDay
    }

    // Perform updates
    await this.update(result.updateData);
    await this.updateEmbeddedDocuments("Item", result.updateItems);

    // Display a Chat Message summarizing the rest effects
    if ( chat ) await this._displayRestResultMessage(result, longRest);

    // Return data summarizing the rest effects
    return result;
  }

  /* -------------------------------------------- */

  /**
   * Display a chat message with the result of a rest.
   *
   * @param {RestResult} result         Result of the rest operation.
   * @param {boolean} [longRest=false]  Is this a long rest?
   * @return {Promise.<ChatMessage>}    Chat message that was created.
   * @protected
   */
  async _displayRestResultMessage(result, longRest=false) {
    const { dhd, dhp, dtp, dfp, newDay } = result;
    const diceRestored = dhd !== 0;
    const healthRestored = dhp !== 0;
    const length = longRest ? "Long" : "Short";

    let restFlavor, message;

    // Summarize the rest duration
    switch (game.settings.get("sw5e", "restVariant")) {
      case 'normal': restFlavor = (longRest && newDay) ? "SW5E.LongRestOvernight" : `SW5E.${length}RestNormal`; break;
      case 'gritty': restFlavor = (!longRest && newDay) ? "SW5E.ShortRestOvernight" : `SW5E.${length}RestGritty`; break;
      case 'epic':  restFlavor = `SW5E.${length}RestEpic`; break;
    }

    // Determine the chat message to display
    if (longRest) {
      message = "SW5E.LongRestResult";
      if (dhp !== 0) message += "HP";
      if (dfp !== 0) message += "FP";
      if (dtp !== 0) message += "TP";
      if (dhd !== 0) message += "HD";
    } else {
      message = "SW5E.ShortRestResultShort";
      if ((dhd !== 0) && (dhp !== 0)){
        if (dtp !== 0){
          message = "SW5E.ShortRestResultWithTech";
        }else{
          message = "SW5E.ShortRestResult";
        }
      }else{
        if (dtp !== 0){
          message = "SW5E.ShortRestResultOnlyTech";
        }
      }
    }

    // Create a chat message
    let chatData = {
      user: game.user.id,
      speaker: {actor: this, alias: this.name},
      flavor: game.i18n.localize(restFlavor),
      content: game.i18n.format(message, {
        name: this.name,
        dice: longRest ? dhd : -dhd,
        health: dhp,
        tech: dtp,
        force: dfp
      })
    };
    ChatMessage.applyRollMode(chatData, game.settings.get("core", "rollMode"));
    return ChatMessage.create(chatData);
  }

  /* -------------------------------------------- */

  /**
   * Automatically spend hit dice to recover hit points up to a certain threshold.
   *
   * @param {object} [options]
   * @param {number} [options.threshold=3]  A number of missing hit points which would trigger an automatic HD roll.
   * @return {Promise.<number>}             Number of hit dice spent.
   */
  async autoSpendHitDice({ threshold=3 }={}) {
    const max = this.data.data.attributes.hp.max + this.data.data.attributes.hp.tempmax;

    let diceRolled = 0;
    while ( (this.data.data.attributes.hp.value + threshold) <= max ) {
      const r = await this.rollHitDie(undefined, {dialog: false});
      if ( r === null ) break;
      diceRolled += 1;
    }

    return diceRolled;
  }

  /* -------------------------------------------- */

  /**
   * Recovers actor hit points and eliminates any temp HP.
   *
   * @param {object} [options]
   * @param {boolean} [options.recoverTemp=true]     Reset temp HP to zero.
   * @param {boolean} [options.recoverTempMax=true]  Reset temp max HP to zero.
   * @return {object}                                Updates to the actor and change in hit points.
   * @protected
   */
  _getRestHitPointRecovery({ recoverTemp=true, recoverTempMax=true }={}) {
    const data = this.data.data;
    let updates = {};
    let max = data.attributes.hp.max;

    if ( recoverTempMax ) {
      updates["data.attributes.hp.tempmax"] = 0;
    } else {
      max += data.attributes.hp.tempmax;
    }
    updates["data.attributes.hp.value"] = max;
    if ( recoverTemp ) {
      updates["data.attributes.hp.temp"] = 0;
    }

    return { updates, hitPointsRecovered: max - data.attributes.hp.value };
  }

  /* -------------------------------------------- */

  /**
   * Recovers actor resources.
   * @param {object} [options]
   * @param {boolean} [options.recoverShortRestResources=true]  Recover resources that recharge on a short rest.
   * @param {boolean} [options.recoverLongRestResources=true]   Recover resources that recharge on a long rest.
   * @return {object}                                           Updates to the actor.
   * @protected
   */
  _getRestResourceRecovery({recoverShortRestResources=true, recoverLongRestResources=true}={}) {
    let updates = {};
    for ( let [k, r] of Object.entries(this.data.data.resources) ) {
      if ( Number.isNumeric(r.max) && ((recoverShortRestResources && r.sr) || (recoverLongRestResources && r.lr)) ) {
        updates[`data.resources.${k}.value`] = Number(r.max);
      }
    }
    return updates;
  }

  /* -------------------------------------------- */

  /**
   * Recovers power slots.
   *
   * @param longRest = true  It's a long rest
   * @return {object}        Updates to the actor.
   * @protected
   */
  _getRestPowerRecovery({ recoverTechPowers=true, recoverForcePowers=true }={}) {
    let updates = {};

    if (recoverTechPowers) {
      updates["data.attributes.tech.points.value"] = this.data.data.attributes.tech.points.max;
      updates["data.attributes.tech.points.temp"] = 0;
      updates["data.attributes.tech.points.tempmax"] = 0;

      for (let [k, v] of Object.entries(this.data.data.powers)) {
        updates[`data.powers.${k}.tvalue`] = Number.isNumeric(v.toverride) ? v.toverride : (v.tmax ?? 0);
      }
    }

    if (recoverForcePowers) {
      updates["data.attributes.force.points.value"] = this.data.data.attributes.force.points.max;
      updates["data.attributes.force.points.temp"] = 0;
      updates["data.attributes.force.points.tempmax"] = 0;

      for ( let [k, v] of Object.entries(this.data.data.powers) ) {
        updates[`data.powers.${k}.fvalue`] = Number.isNumeric(v.foverride) ? v.foverride : (v.fmax ?? 0);
      }
    }

    return updates;
  }

  /* -------------------------------------------- */

  /**
   * Recovers class hit dice during a long rest.
   *
   * @param {object} [options]
   * @param {number} [options.maxHitDice]  Maximum number of hit dice to recover.
   * @return {object}                      Array of item updates and number of hit dice recovered.
   * @protected
   */
  _getRestHitDiceRecovery({ maxHitDice=undefined }={}) {
    // Determine the number of hit dice which may be recovered
    if ( maxHitDice === undefined ) {
      maxHitDice = Math.max(Math.floor(this.data.data.details.level / 2), 1);
    }

    // Sort classes which can recover HD, assuming players prefer recovering larger HD first.
    const sortedClasses = Object.values(this.classes).sort((a, b) => {
      return (parseInt(b.data.data.hitDice.slice(1)) || 0) - (parseInt(a.data.data.hitDice.slice(1)) || 0);
    });

    let updates = [];
    let hitDiceRecovered = 0;
    for ( let item of sortedClasses ) {
      const d = item.data.data;
      if ( (hitDiceRecovered < maxHitDice) && (d.hitDiceUsed > 0) ) {
        let delta = Math.min(d.hitDiceUsed || 0, maxHitDice - hitDiceRecovered);
        hitDiceRecovered += delta;
        updates.push({_id: item.id, "data.hitDiceUsed": d.hitDiceUsed - delta});
      }
    }

    return { updates, hitDiceRecovered };
  }

  /* -------------------------------------------- */

  /**
   * Recovers item uses during short or long rests.
   *
   * @param {object} [options]
   * @param {boolean} [options.recoverShortRestUses=true]  Recover uses for items that recharge after a short rest.
   * @param {boolean} [options.recoverLongRestUses=true]   Recover uses for items that recharge after a long rest.
   * @param {boolean} [options.recoverDailyUses=true]      Recover uses for items that recharge on a new day.
   * @return {Array.<object>}                              Array of item updates.
   * @protected
   */
  _getRestItemUsesRecovery({ recoverShortRestUses=true, recoverLongRestUses=true, recoverDailyUses=true }={}) {
    let recovery = [];
    if ( recoverShortRestUses ) recovery.push("sr");
    if ( recoverLongRestUses ) recovery.push("lr");
    if ( recoverDailyUses ) recovery.push("day");

    let updates = [];
    for ( let item of this.items ) {
      const d = item.data.data;
      if ( d.uses && recovery.includes(d.uses.per) ) {
        updates.push({_id: item.id, "data.uses.value": d.uses.max});
      }
      if ( recoverLongRestUses && d.recharge && d.recharge.value ) {
        updates.push({_id: item.id, "data.recharge.charged": true});
      }
    }

    return updates;
  }

  /* -------------------------------------------- */

  /**
   * Transform this Actor into another one.
   *
   * @param {Actor} target The target Actor.
   * @param {boolean} [keepPhysical] Keep physical abilities (str, dex, con)
   * @param {boolean} [keepMental] Keep mental abilities (int, wis, cha)
   * @param {boolean} [keepSaves] Keep saving throw proficiencies
   * @param {boolean} [keepSkills] Keep skill proficiencies
   * @param {boolean} [mergeSaves] Take the maximum of the save proficiencies
   * @param {boolean} [mergeSkills] Take the maximum of the skill proficiencies
   * @param {boolean} [keepClass] Keep proficiency bonus
   * @param {boolean} [keepFeats] Keep features
   * @param {boolean} [keepPowers] Keep powers
   * @param {boolean} [keepItems] Keep items
   * @param {boolean} [keepBio] Keep biography
   * @param {boolean} [keepVision] Keep vision
   * @param {boolean} [transformTokens] Transform linked tokens too
   */
  async transformInto(target, { keepPhysical=false, keepMental=false, keepSaves=false, keepSkills=false,
    mergeSaves=false, mergeSkills=false, keepClass=false, keepFeats=false, keepPowers=false,
    keepItems=false, keepBio=false, keepVision=false, transformTokens=true}={}) {

    // Ensure the player is allowed to polymorph
    const allowed = game.settings.get("sw5e", "allowPolymorphing");
    if ( !allowed && !game.user.isGM ) {
      return ui.notifications.warn(game.i18n.localize("SW5E.PolymorphWarn"));
    }

    // Get the original Actor data and the new source data
    const o = this.toJSON();
    o.flags.sw5e = o.flags.sw5e || {};
    o.flags.sw5e.transformOptions = {mergeSkills, mergeSaves};
    const source = target.toJSON();

    // Prepare new data to merge from the source
    const d = {
      type: o.type, // Remain the same actor type
      name: `${o.name} (${source.name})`, // Append the new shape to your old name
      data: source.data, // Get the data model of your new form
      items: source.items, // Get the items of your new form
      effects: o.effects.concat(source.effects), // Combine active effects from both forms
      img: source.img, // New appearance
      permission: o.permission, // Use the original actor permissions
      folder: o.folder, // Be displayed in the same sidebar folder
      flags: o.flags // Use the original actor flags
    };

    // Specifically delete some data attributes
    delete d.data.resources; // Don't change your resource pools
    delete d.data.currency; // Don't lose currency
    delete d.data.bonuses; // Don't lose global bonuses

    // Specific additional adjustments
    d.data.details.alignment = o.data.details.alignment; // Don't change alignment
    d.data.attributes.exhaustion = o.data.attributes.exhaustion; // Keep your prior exhaustion level
    d.data.attributes.inspiration = o.data.attributes.inspiration; // Keep inspiration
    d.data.powers = o.data.powers; // Keep power slots

    // Token appearance updates
    d.token = {name: d.name};
    for ( let k of ["width", "height", "scale", "img", "mirrorX", "mirrorY", "tint", "alpha", "lockRotation"] ) {
      d.token[k] = source.token[k];
    }
    if ( !keepVision ) {
      for ( let k of ['dimSight', 'brightSight', 'dimLight', 'brightLight', 'vision', 'sightAngle'] ) {
        d.token[k] = source.token[k];
      }
    }
    if ( source.token.randomImg ) {
      const images = await target.getTokenImages();
      d.token.img = images[Math.floor(Math.random() * images.length)];
    }

    // Transfer ability scores
    const abilities = d.data.abilities;
    for ( let k of Object.keys(abilities) ) {
      const oa = o.data.abilities[k];
      const prof = abilities[k].proficient;
      if ( keepPhysical && ["str", "dex", "con"].includes(k) ) abilities[k] = oa;
      else if ( keepMental && ["int", "wis", "cha"].includes(k) ) abilities[k] = oa;
      if ( keepSaves ) abilities[k].proficient = oa.proficient;
      else if ( mergeSaves ) abilities[k].proficient = Math.max(prof, oa.proficient);
    }

    // Transfer skills
    if ( keepSkills ) d.data.skills = o.data.skills;
    else if ( mergeSkills ) {
      for ( let [k, s] of Object.entries(d.data.skills) ) {
        s.value = Math.max(s.value, o.data.skills[k].value);
      }
    }

    // Keep specific items from the original data
    d.items = d.items.concat(o.items.filter(i => {
      if ( i.type === "class" ) return keepClass;
      else if ( i.type === "feat" ) return keepFeats;
      else if ( i.type === "power" ) return keepPowers;
      else return keepItems;
    }));

    // Transfer classes for NPCs
    if (!keepClass && d.data.details.cr) {
      d.items.push({
        type: 'class',
        name: game.i18n.localize('SW5E.PolymorphTmpClass'),
        data: { levels: d.data.details.cr }
      });
    }

    // Keep biography
    if (keepBio) d.data.details.biography = o.data.details.biography;

    // Keep senses
    if (keepVision) d.data.traits.senses = o.data.traits.senses;

    // Set new data flags
    if ( !this.isPolymorphed || !d.flags.sw5e.originalActor ) d.flags.sw5e.originalActor = this.id;
    d.flags.sw5e.isPolymorphed = true;

    // Update unlinked Tokens in place since they can simply be re-dropped from the base actor
    if (this.isToken) {
      const tokenData = d.token;
      tokenData.actorData = d;
      delete tokenData.actorData.token;
      return this.token.update(tokenData);
    }

    // Update regular Actors by creating a new Actor with the Polymorphed data
    await this.sheet.close();
    Hooks.callAll('sw5e.transformActor', this, target, d, {
      keepPhysical, keepMental, keepSaves, keepSkills, mergeSaves, mergeSkills,
      keepClass, keepFeats, keepPowers, keepItems, keepBio, keepVision, transformTokens
    });
    const newActor = await this.constructor.create(d, {renderSheet: true});

    // Update placed Token instances
    if ( !transformTokens ) return;
    const tokens = this.getActiveTokens(true);
    const updates = tokens.map(t => {
      const newTokenData = foundry.utils.deepClone(d.token);
      if ( !t.data.actorLink ) newTokenData.actorData = newActor.data;
      newTokenData._id = t.data._id;
      newTokenData.actorId = newActor.id;
      return newTokenData;
    });
    return canvas.scene?.updateEmbeddedDocuments("Token", updates);
  }

  /* -------------------------------------------- */

  /**
   * If this actor was transformed with transformTokens enabled, then its
   * active tokens need to be returned to their original state. If not, then
   * we can safely just delete this actor.
   */
  async revertOriginalForm() {
    if ( !this.isPolymorphed ) return;
    if ( !this.isOwner ) {
      return ui.notifications.warn(game.i18n.localize("SW5E.PolymorphRevertWarn"));
    }

    // If we are reverting an unlinked token, simply replace it with the base actor prototype
    if ( this.isToken ) {
      const baseActor = game.actors.get(this.token.data.actorId);
      const prototypeTokenData = await baseActor.getTokenData();
      const tokenUpdate = {actorData: {}};
      for ( let k of ["width", "height", "scale", "img", "mirrorX", "mirrorY", "tint", "alpha", "lockRotation"] ) {
        tokenUpdate[k] = prototypeTokenData[k];
      }
      return this.token.update(tokenUpdate, {recursive: false});
    }

    // Obtain a reference to the original actor
    const original = game.actors.get(this.getFlag('sw5e', 'originalActor'));
    if ( !original ) return;

    // Get the Tokens which represent this actor
    if ( canvas.ready ) {
      const tokens = this.getActiveTokens(true);
      const tokenData = await original.getTokenData();
      const tokenUpdates = tokens.map(t => {
        const update = duplicate(tokenData);
        update._id = t.id;
        delete update.x;
        delete update.y;
        return update;
      });
      canvas.scene.updateEmbeddedDocuments("Token", tokenUpdates);
    }

    // Delete the polymorphed version of the actor, if possible
    const isRendered = this.sheet.rendered;
    if ( game.user.isGM ) await this.delete();
    else if ( isRendered ) this.sheet.close();
    if ( isRendered ) original.sheet.render(isRendered);
    return original;
  }

  /* -------------------------------------------- */

  /**
   * Add additional system-specific sidebar directory context menu options for SW5e Actor entities
   * @param {jQuery} html         The sidebar HTML
   * @param {Array} entryOptions  The default array of context menu options
   */
  static addDirectoryContextOptions(html, entryOptions) {
    entryOptions.push({
      name: 'SW5E.PolymorphRestoreTransformation',
      icon: '<i class="fas fa-backward"></i>',
      callback: li => {
        const actor = game.actors.get(li.data('entityId'));
        return actor.revertOriginalForm();
      },
      condition: li => {
        const allowed = game.settings.get("sw5e", "allowPolymorphing");
        if ( !allowed && !game.user.isGM ) return false;
        const actor = game.actors.get(li.data('entityId'));
        return actor && actor.isPolymorphed;
      }
    });
  }

  /* -------------------------------------------- */

  /**
   * Format a type object into a string.
   * @param {object} typeData          The type data to convert to a string.
   * @returns {string}
   */
  static formatCreatureType(typeData) {
    if ( typeof typeData === "string" ) return typeData; // backwards compatibility
    let localizedType;
    if ( typeData.value === "custom" ) {
      localizedType = typeData.custom;
    } else {
      let code = CONFIG.SW5E.creatureTypes[typeData.value];
      localizedType = game.i18n.localize(!!typeData.swarm ? `${code}Pl` : code);
    }
    let type = localizedType;
    if ( !!typeData.swarm ) {
      type = game.i18n.format('SW5E.CreatureSwarmPhrase', {
        size: game.i18n.localize(CONFIG.SW5E.actorSizes[typeData.swarm]),
        type: localizedType
      });
    }
    if (typeData.subtype) type = `${type} (${typeData.subtype})`;
    return type;
  }

  /* -------------------------------------------- */
  /*  DEPRECATED METHODS                          */
  /* -------------------------------------------- */

  /**
   * @deprecated since sw5e 0.97
   */
  getPowerDC(ability) {
    console.warn(`The Actor5e#getPowerDC(ability) method has been deprecated in favor of Actor5e#data.data.abilities[ability].dc`);
    return this.data.data.abilities[ability]?.dc;
  }

  /* -------------------------------------------- */

  /**
   * Cast a Power, consuming a power slot of a certain level
   * @param {Item5e} item   The power being cast by the actor
   * @param {Event} event   The originating user interaction which triggered the cast
   * @deprecated since sw5e 1.2.0
   */
  async usePower(item, {configureDialog=true}={}) {
    console.warn(`The Actor5e#usePower method has been deprecated in favor of Item5e#roll`);
    if ( item.data.type !== "power" ) throw new Error("Wrong Item type");
    return item.roll();
  }
}