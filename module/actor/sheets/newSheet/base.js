import Item5e from "../../../item/entity.js";
import TraitSelector from "../../../apps/trait-selector.js";
import ActorSheetFlags from "../../../apps/actor-flags.js";
import ActorHitDiceConfig from "../../../apps/hit-dice-config.js";
import ActorMovementConfig from "../../../apps/movement-config.js";
import ActorSensesConfig from "../../../apps/senses-config.js";
import ActorTypeConfig from "../../../apps/actor-type.js";
import {SW5E} from '../../../config.js';
import {onManageActiveEffect, prepareActiveEffectCategories} from "../../../effects.js";

/**
 * Extend the basic ActorSheet class to suppose SW5e-specific logic and functionality.
 * This sheet is an Abstract layer which is not used.
 * @extends {ActorSheet}
 */
export default class ActorSheet5e extends ActorSheet {
  constructor(...args) {
    super(...args);

    /**
     * Track the set of item filters which are applied
     * @type {Set}
     */
    this._filters = {
      inventory: new Set(),
      forcePowerbook: new Set(),
      techPowerbook: new Set(),
      features: new Set(),
      effects: new Set()
    };
  }

  /* -------------------------------------------- */

  /** @override */
  static get defaultOptions() {
    return mergeObject(super.defaultOptions, {
      scrollY: [
        ".inventory .group-list",
        ".features .group-list",
        ".force-powerbook .group-list",
        ".tech-powerbook .group-list",
        ".effects .effects-list"
      ],
      tabs: [{navSelector: ".tabs", contentSelector: ".sheet-body", initial: "description"}]
    });
  }

  /* -------------------------------------------- */

  /**
   * A set of item types that should be prevented from being dropped on this type of actor sheet.
   * @type {Set<string>}
   */
  static unsupportedItemTypes = new Set();

  /* -------------------------------------------- */

  /** @override */
  get template() {
    if ( !game.user.isGM && this.actor.limited ) return "systems/sw5e/templates/actors/newActor/expanded-limited-sheet.html";
    return `systems/sw5e/templates/actors/newActor/${this.actor.data.type}-sheet.html`;
  }

  /* -------------------------------------------- */

  /** @override */
  getData(options) {

    // Basic data
    let isOwner = this.actor.isOwner;
    const data = {
      owner: isOwner,
      limited: this.actor.limited,
      options: this.options,
      editable: this.isEditable,
      cssClass: isOwner ? "editable" : "locked",
      isCharacter: this.actor.type === "character",
      isNPC: this.actor.type === "npc",
      isStarship: this.actor.type === "starship",
      isVehicle: this.actor.type === 'vehicle',
      config: CONFIG.SW5E,
      rollData: this.actor.getRollData.bind(this.actor)
    };

    // The Actor's data
    const actorData = this.actor.data.toObject(false);
    data.actor = actorData;
    data.data = actorData.data;

    // Owned Items
    data.items = actorData.items;
    for ( let i of data.items ) {
      const item = this.actor.items.get(i._id);
      i.labels = item.labels;
    }
    data.items.sort((a, b) => (a.sort || 0) - (b.sort || 0));

    // Labels and filters
    data.labels = this.actor.labels || {};
    data.filters = this._filters;

    // Ability Scores
    for ( let [a, abl] of Object.entries(actorData.data.abilities)) {
      abl.icon = this._getProficiencyIcon(abl.proficient);
      abl.hover = CONFIG.SW5E.proficiencyLevels[abl.proficient];
      abl.label = CONFIG.SW5E.abilities[a];
    }

    // Skills
    if (actorData.data.skills) {
      for (let [s, skl] of Object.entries(actorData.data.skills)) {
        skl.ability = CONFIG.SW5E.abilityAbbreviations[skl.ability];
        skl.icon = this._getProficiencyIcon(skl.value);
        skl.hover = CONFIG.SW5E.proficiencyLevels[skl.value];
        if (data.actor.type === "starship") {
          skl.label = CONFIG.SW5E.starshipSkills[s];
        }else{
          skl.label = CONFIG.SW5E.skills[s];
        }
      }
    }

    // Movement speeds
    data.movement = this._getMovementSpeed(actorData);

    // Senses
    data.senses = this._getSenses(actorData);

    // Update traits
    this._prepareTraits(actorData.data.traits);

    // Prepare owned items
    this._prepareItems(data);

    // Prepare active effects
    data.effects = prepareActiveEffectCategories(this.actor.effects);

    // Return data to the sheet
    return data
  }

  /* -------------------------------------------- */

  /**
   * Prepare the display of movement speed data for the Actor*
   * @param {object} actorData                The Actor data being prepared.
   * @param {boolean} [largestPrimary=false]  Show the largest movement speed as "primary", otherwise show "walk"
   * @returns {{primary: string, special: string}}
   * @private
   */
  _getMovementSpeed(actorData, largestPrimary=false) {
    const movement = actorData.data.attributes.movement || {};

    // Prepare an array of available movement speeds
    let speeds = [
      [movement.burrow, `${game.i18n.localize("SW5E.MovementBurrow")} ${movement.burrow}`],
      [movement.climb, `${game.i18n.localize("SW5E.MovementClimb")} ${movement.climb}`],
      [movement.fly, `${game.i18n.localize("SW5E.MovementFly")} ${movement.fly}` + (movement.hover ? ` (${game.i18n.localize("SW5E.MovementHover")})` : "")],
      [movement.swim, `${game.i18n.localize("SW5E.MovementSwim")} ${movement.swim}`]
    ]
    if ( largestPrimary ) {
      speeds.push([movement.walk, `${game.i18n.localize("SW5E.MovementWalk")} ${movement.walk}`]);
    }

    // Filter and sort speeds on their values
    speeds = speeds.filter(s => !!s[0]).sort((a, b) => b[0] - a[0]);

    // Case 1: Largest as primary
    if ( largestPrimary ) {
      let primary = speeds.shift();
      return {
        primary: `${primary ? primary[1] : "0"} ${movement.units}`,
        special: speeds.map(s => s[1]).join(", ")
      }
    }

    // Case 2: Walk as primary
    else {
      return {
        primary: `${movement.walk || 0} ${movement.units}`,
        special: speeds.length ? speeds.map(s => s[1]).join(", ") : ""
      }
    }
  }

  /* -------------------------------------------- */

  _getSenses(actorData) {
    const senses = actorData.data.attributes.senses || {};
    const tags = {};
    for ( let [k, label] of Object.entries(CONFIG.SW5E.senses) ) {
      const v = senses[k] ?? 0
      if ( v === 0 ) continue;
      tags[k] = `${game.i18n.localize(label)} ${v} ${senses.units}`;
    }
    if ( !!senses.special ) tags["special"] = senses.special;
    return tags;
  }

  /* -------------------------------------------- */

  /**
   * Prepare the data structure for traits data like languages, resistances & vulnerabilities, and proficiencies
   * @param {object} traits   The raw traits data object from the actor data
   * @private
   */
  _prepareTraits(traits) {
    const map = {
      "dr": CONFIG.SW5E.damageResistanceTypes,
      "di": CONFIG.SW5E.damageResistanceTypes,
      "dv": CONFIG.SW5E.damageResistanceTypes,
      "ci": CONFIG.SW5E.conditionTypes,
      "languages": CONFIG.SW5E.languages,
      "armorProf": CONFIG.SW5E.armorProficiencies,
      "weaponProf": CONFIG.SW5E.weaponProficiencies,
      "toolProf": CONFIG.SW5E.toolProficiencies
    };
    for ( let [t, choices] of Object.entries(map) ) {
      const trait = traits[t];
      if ( !trait ) continue;
      let values = [];
      if ( trait.value ) {
        values = trait.value instanceof Array ? trait.value : [trait.value];
      }
      trait.selected = values.reduce((obj, t) => {
        obj[t] = choices[t];
        return obj;
      }, {});

      // Add custom entry
      if ( trait.custom ) {
        trait.custom.split(";").forEach((c, i) => trait.selected[`custom${i+1}`] = c.trim());
      }
      trait.cssClass = !isObjectEmpty(trait.selected) ? "" : "inactive";
    }
  }

  /* -------------------------------------------- */

  /**
   * Insert a power into the powerbook object when rendering the character sheet
   * @param {Object}  data    The Actor data being prepared
   * @param {Array}   powers  The power data being prepared
   * @param {string}  school  The school of the powerbook being prepared
   * @private
   */
  _preparePowerbook(data, powers, school) {
    const owner = this.actor.isOwner;
    const levels = data.data.powers;
    const powerbook = {};

    // Define some mappings
    const sections = {
      "atwill": -20,
      "innate": -10,
    };

    // Label power slot uses headers
    const useLabels = {
      "-20": "-",
      "-10": "-",
      "0": "&infin;"
    };

    // Format a powerbook entry for a certain indexed level
    const registerSection = (sl, i, label, {prepMode="prepared", value, max, override}={}) => {
      powerbook[i] = {
        order: i,
        label: label,
        usesSlots: i > 0,
        canCreate: owner,
        canPrepare: (data.actor.type === "character") && (i >= 1),
        powers: [],
        uses: useLabels[i] || value || 0,
        slots: useLabels[i] || max || 0,
        override: override || 0,
        dataset: {"type": "power", "level": prepMode in sections ? 1 : i, "preparation.mode": prepMode, "school": school},
        prop: sl
      };
    };

    // Determine the maximum power level which has a slot
    const maxLevel = Array.fromRange(10).reduce((max, i) => {
      if ( i === 0 ) return max;
      const level = levels[`power${i}`];
      if ( (level.max || level.override ) && ( i > max ) ) max = i;
      return max;
    }, 0);

    // Level-based powercasters have cantrips and leveled slots
    if ( maxLevel > 0 ) {
      registerSection("power0", 0, CONFIG.SW5E.powerLevels[0]);
      for (let lvl = 1; lvl <= maxLevel; lvl++) {
        const sl = `power${lvl}`;
        registerSection(sl, lvl, CONFIG.SW5E.powerLevels[lvl], levels[sl]);
      }
    }

    // Iterate over every power item, adding powers to the powerbook by section
    powers.forEach(power => {
      const mode = power.data.preparation.mode || "prepared";
      let s = power.data.level || 0;
      const sl = `power${s}`;

      // Specialized powercasting modes (if they exist)
      if ( mode in sections ) {
        s = sections[mode];
        if ( !powerbook[s] ){
          const l = levels[mode] || {};
          const config = CONFIG.SW5E.powerPreparationModes[mode];
          registerSection(mode, s, config, {
            prepMode: mode,
            value: l.value,
            max: l.max,
            override: l.override
          });
        }
      }

      // Sections for higher-level powers which the caster "should not" have, but power items exist for
      else if ( !powerbook[s] ) {
        registerSection(sl, s, CONFIG.SW5E.powerLevels[s], {levels: levels[sl]});
      }

      // Add the power to the relevant heading
      powerbook[s].powers.push(power);
    });

    // Sort the powerbook by section level
    const sorted = Object.values(powerbook);
    sorted.sort((a, b) => a.order - b.order);
    return sorted;
  }

  /* -------------------------------------------- */

  /**
   * Determine whether an Owned Item will be shown based on the current set of filters
   * @return {boolean}
   * @private
   */
  _filterItems(items, filters) {
    return items.filter(item => {
      const data = item.data;

      // Action usage
      for ( let f of ["action", "bonus", "reaction"] ) {
        if ( filters.has(f) ) {
          if ((data.activation && (data.activation.type !== f))) return false;
        }
      }

      // Power-specific filters
      if ( filters.has("ritual") ) {
        if (data.components.ritual !== true) return false;
      }
      if ( filters.has("concentration") ) {
        if (data.components.concentration !== true) return false;
      }
      if ( filters.has("prepared") ) {
        if ( data.level === 0 || ["innate", "always"].includes(data.preparation.mode) ) return true;
        if ( this.actor.data.type === "npc" ) return true;
        if ( this.actor.data.type === "starship" ) return true;		
        return data.preparation.prepared;
      }

      // Equipment-specific filters
      if ( filters.has("equipped") ) {
        if ( data.equipped !== true ) return false;
      }
      return true;
    });
  }

  /* -------------------------------------------- */

  /**
   * Get the font-awesome icon used to display a certain level of skill proficiency
   * @private
   */
  _getProficiencyIcon(level) {
    const icons = {
      0: '<i class="far fa-circle"></i>',
      0.5: '<i class="fas fa-adjust"></i>',
      1: '<i class="fas fa-check"></i>',
      2: '<i class="fas fa-check-double"></i>'
    };
    return icons[level] || icons[0];
  }

  /* -------------------------------------------- */
  /*  Event Listeners and Handlers
  /* -------------------------------------------- */

  /** @inheritdoc */
  activateListeners(html) {

    // Activate Item Filters
    const filterLists = html.find(".filter-list");
    filterLists.each(this._initializeFilterItemList.bind(this));
    filterLists.on("click", ".filter-item", this._onToggleFilter.bind(this));

    // Item summaries
    html.find('.item .item-name.rollable h4').click(event => this._onItemSummary(event));

    // View Item Sheets
    html.find('.item-edit').click(this._onItemEdit.bind(this));

    // Editable Only Listeners
    if ( this.isEditable ) {

      // Input focus and update
      const inputs = html.find("input");
      inputs.focus(ev => ev.currentTarget.select());
      inputs.addBack().find('[data-dtype="Number"]').change(this._onChangeInputDelta.bind(this));

      // Ability Proficiency
      html.find('.ability-proficiency').click(this._onToggleAbilityProficiency.bind(this));

      // Toggle Skill Proficiency
      html.find('.skill-proficiency').on("click contextmenu", this._onCycleSkillProficiency.bind(this));

      // Trait Selector
      html.find('.trait-selector').click(this._onTraitSelector.bind(this));

      // Configure Special Flags
      html.find('.config-button').click(this._onConfigMenu.bind(this));

      // Owned Item management
      html.find('.item-create').click(this._onItemCreate.bind(this));
      html.find('.item-delete').click(this._onItemDelete.bind(this));
      html.find('.item-collapse').click(this._onItemCollapse.bind(this));
      html.find('.item-uses input').click(ev => ev.target.select()).change(this._onUsesChange.bind(this));
      html.find('.slot-max-override').click(this._onPowerSlotOverride.bind(this));
      html.find('.increment-class-level').click(this._onIncrementClassLevel.bind(this));
      html.find('.decrement-class-level').click(this._onDecrementClassLevel.bind(this));

      // Active Effect management
      html.find(".effect-control").click(ev => onManageActiveEffect(ev, this.actor));
    }

    // Owner Only Listeners
    if ( this.actor.isOwner ) {

      // Ability Checks
      html.find('.ability-name').click(this._onRollAbilityTest.bind(this));


      // Roll Skill Checks
      html.find('.skill-name').click(this._onRollSkillCheck.bind(this));

      // Item Rolling
      html.find('.item .item-image').click(event => this._onItemRoll(event));
      html.find('.item .item-recharge').click(event => this._onItemRecharge(event));
    }

    // Otherwise remove rollable classes
    else {
      html.find(".rollable").each((i, el) => el.classList.remove("rollable"));
    }

    // Handle default listeners last so system listeners are triggered first
    super.activateListeners(html);
  }

  /* -------------------------------------------- */

  /**
   * Iinitialize Item list filters by activating the set of filters which are currently applied
   * @private
   */
  _initializeFilterItemList(i, ul) {
    const set = this._filters[ul.dataset.filter];
    const filters = ul.querySelectorAll(".filter-item");
    for ( let li of filters ) {
      if ( set.has(li.dataset.filter) ) li.classList.add("active");
    }
  }

  /* -------------------------------------------- */
  /*  Event Listeners and Handlers                */
  /* -------------------------------------------- */

  /**
   * Handle input changes to numeric form fields, allowing them to accept delta-typed inputs
   * @param event
   * @private
   */
  _onChangeInputDelta(event) {
    const input = event.target;
    const value = input.value;
    if ( ["+", "-"].includes(value[0]) ) {
      let delta = parseFloat(value);
      input.value = getProperty(this.actor.data, input.name) + delta;
    } else if ( value[0] === "=" ) {
      input.value = value.slice(1);
    }
  }

  /* -------------------------------------------- */

  /**
   * Handle spawning the TraitSelector application which allows a checkbox of multiple trait options
   * @param {Event} event   The click event which originated the selection
   * @private
   */
  _onConfigMenu(event) {
    event.preventDefault();
    const button = event.currentTarget;
    let app;
    switch ( button.dataset.action ) {
      case "hit-dice":
        app = new ActorHitDiceConfig(this.object);
        break;
      case "movement":
        app = new ActorMovementConfig(this.object);
        break;
      case "flags":
        app = new ActorSheetFlags(this.object);
        break;
      case "senses":
        app = new ActorSensesConfig(this.object);
        break;
      case "type":
        new ActorTypeConfig(this.object).render(true);
        break;
    }
    app?.render(true);
  }

  /* -------------------------------------------- */

  /**
   * Handle cycling proficiency in a Skill
   * @param {Event} event   A click or contextmenu event which triggered the handler
   * @private
   */
  _onCycleSkillProficiency(event) {
    event.preventDefault();
    const field = $(event.currentTarget).siblings('input[type="hidden"]');

    // Get the current level and the array of levels
    const level = parseFloat(field.val());
    const levels = [0, 1, 0.5, 2];
    let idx = levels.indexOf(level);

    // Toggle next level - forward on click, backwards on right
    if ( event.type === "click" ) {
      field.val(levels[(idx === levels.length - 1) ? 0 : idx + 1]);
    } else if ( event.type === "contextmenu" ) {
      field.val(levels[(idx === 0) ? levels.length - 1 : idx - 1]);
    }

    // Update the field value and save the form
    this._onSubmit(event);
  }

  /* -------------------------------------------- */

  /** @override */
  async _onDropActor(event, data) {
    const canPolymorph = game.user.isGM || (this.actor.isOwner && game.settings.get('sw5e', 'allowPolymorphing'));
    if ( !canPolymorph ) return false;

    // Get the target actor
    let sourceActor = null;
    if (data.pack) {
      const pack = game.packs.find(p => p.collection === data.pack);
      sourceActor = await pack.getEntity(data.id);
    } else {
      sourceActor = game.actors.get(data.id);
    }
    if ( !sourceActor ) return;

    // Define a function to record polymorph settings for future use
    const rememberOptions = html => {
      const options = {};
      html.find('input').each((i, el) => {
        options[el.name] = el.checked;
      });
      const settings = mergeObject(game.settings.get('sw5e', 'polymorphSettings') || {}, options);
      game.settings.set('sw5e', 'polymorphSettings', settings);
      return settings;
    };

    // Create and render the Dialog
    return new Dialog({
      title: game.i18n.localize('SW5E.PolymorphPromptTitle'),
      content: {
        options: game.settings.get('sw5e', 'polymorphSettings'),
        i18n: SW5E.polymorphSettings,
        isToken: this.actor.isToken
      },
      default: 'accept',
      buttons: {
        accept: {
          icon: '<i class="fas fa-check"></i>',
          label: game.i18n.localize('SW5E.PolymorphAcceptSettings'),
          callback: html => this.actor.transformInto(sourceActor, rememberOptions(html))
        },
        wildshape: {
          icon: '<i class="fas fa-paw"></i>',
          label: game.i18n.localize('SW5E.PolymorphWildShape'),
          callback: html => this.actor.transformInto(sourceActor, {
            keepBio: true,
            keepClass: true,
            keepMental: true,
            mergeSaves: true,
            mergeSkills: true,
            transformTokens: rememberOptions(html).transformTokens
          })
        },
        polymorph: {
          icon: '<i class="fas fa-pastafarianism"></i>',
          label: game.i18n.localize('SW5E.Polymorph'),
          callback: html => this.actor.transformInto(sourceActor, {
            transformTokens: rememberOptions(html).transformTokens
          })
        },
        cancel: {
          icon: '<i class="fas fa-times"></i>',
          label: game.i18n.localize('Cancel')
        }
      }
    }, {
      classes: ['dialog', 'sw5e'],
      width: 600,
      template: 'systems/sw5e/templates/apps/polymorph-prompt.html'
    }).render(true);
  }

  /* -------------------------------------------- */

  /** @override */
  async _onDropItemCreate(itemData) {

    // Check to make sure items of this type are allowed on this actor
    if ( this.constructor.unsupportedItemTypes.has(itemData.type) ) {
      return ui.notifications.warn(game.i18n.format("SW5E.ActorWarningInvalidItem", {
        itemType: game.i18n.localize(CONFIG.Item.typeLabels[itemData.type]),
        actorType: game.i18n.localize(CONFIG.Actor.typeLabels[this.actor.type])
      }));
    }

    // Create a Consumable power scroll on the Inventory tab
    if ( (itemData.type === "power") && (this._tabs[0].active === "inventory") ) {
      const scroll = await Item5e.createScrollFromPower(itemData);
      itemData = scroll.data;
    }

    if ( itemData.data ) {
      // Ignore certain statuses
      ["equipped", "proficient", "prepared"].forEach(k => delete itemData.data[k]);

      // Downgrade ATTUNED to REQUIRED
      itemData.data.attunement = Math.min(itemData.data.attunement, CONFIG.SW5E.attunementTypes.REQUIRED);
    }

    // Stack identical consumables
    if ( itemData.type === "consumable" && itemData.flags.core?.sourceId ) {
      const similarItem = this.actor.items.find(i => {
        const sourceId = i.getFlag("core", "sourceId");
        return sourceId && (sourceId === itemData.flags.core?.sourceId) &&
            (i.type === "consumable");
      });
      if ( similarItem ) {
        return similarItem.update({
          'data.quantity': similarItem.data.data.quantity + Math.max(itemData.data.quantity, 1)
        });
      }
    }

    // Create the owned item as normal
    return super._onDropItemCreate(itemData);
  }

  /* -------------------------------------------- */

  /**
   * Handle enabling editing for a power slot override value
   * @param {MouseEvent} event    The originating click event
   * @private
   */
  async _onPowerSlotOverride (event) {
    const span = event.currentTarget.parentElement;
    const level = span.dataset.level;
    const override = this.actor.data.data.powers[level].override || span.dataset.slots;
    const input = document.createElement("INPUT");
    input.type = "text";
    input.name = `data.powers.${level}.override`;
    input.value = override;
    input.placeholder = span.dataset.slots;
    input.dataset.dtype = "Number";

    // Replace the HTML
    const parent = span.parentElement;
    parent.removeChild(span);
    parent.appendChild(input);
  }

  /* -------------------------------------------- */

  /**
   * Change the uses amount of an Owned Item within the Actor
   * @param {Event} event   The triggering click event
   * @private
   */
  async _onUsesChange(event) {
      event.preventDefault();
      const itemId = event.currentTarget.closest(".item").dataset.itemId;
      const item = this.actor.items.get(itemId);
      const uses = Math.clamped(0, parseInt(event.target.value), item.data.data.uses.max);
      event.target.value = uses;
      return item.update({ 'data.uses.value': uses });
  }

  /* -------------------------------------------- */

  /**
   * Handle rolling of an item from the Actor sheet, obtaining the Item instance and dispatching to it's roll method
   * @private
   */
  _onItemRoll(event) {
    event.preventDefault();
    const itemId = event.currentTarget.closest(".item").dataset.itemId;
    const item = this.actor.items.get(itemId);
    return item.roll();
  }

  /* -------------------------------------------- */

  /**
   * Handle attempting to recharge an item usage by rolling a recharge check
   * @param {Event} event   The originating click event
   * @private
   */
  _onItemRecharge(event) {
    event.preventDefault();
    const itemId = event.currentTarget.closest(".item").dataset.itemId;
    const item = this.actor.items.get(itemId);
    return item.rollRecharge();
  };

  /* -------------------------------------------- */

  /**
   * Handle rolling of an item from the Actor sheet, obtaining the Item instance and dispatching to it's roll method
   * @private
   */
  _onItemSummary(event) {
    event.preventDefault();
    let li = $(event.currentTarget).parents(".item"),
        item = this.actor.items.get(li.data("item-id")),
        chatData = item.getChatData({secrets: this.actor.isOwner});

    // Toggle summary
    if ( li.hasClass("expanded") ) {
      let summary = li.children(".item-summary");
      summary.slideUp(200, () => summary.remove());
    } else {
      let div = $(`<div class="item-summary">${chatData.description.value}</div>`);
      let props = $(`<div class="item-properties"></div>`);
      chatData.properties.forEach(p => props.append(`<span class="tag">${p}</span>`));
      div.append(props);
      li.append(div.hide());
      div.slideDown(200);
    }
    li.toggleClass("expanded");
  }

  /* -------------------------------------------- */

  /**
   * Handle creating a new Owned Item for the actor using initial data defined in the HTML dataset
   * @param {Event} event   The originating click event
   * @private
   */
  _onItemCreate(event) {
    event.preventDefault();
    const header = event.currentTarget;
    const type = header.dataset.type;
    const itemData = {
      name: game.i18n.format("SW5E.ItemNew", {type: game.i18n.localize(`SW5E.ItemType${type.capitalize()}`)}),
      type: type,
      data: foundry.utils.deepClone(header.dataset)
    };
    delete itemData.data["type"];
    return this.actor.createEmbeddedDocuments("Item", [itemData]);
  }

  /* -------------------------------------------- */

  /**
   * Handle editing an existing Owned Item for the Actor
   * @param {Event} event   The originating click event
   * @private
   */
  _onItemEdit(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    return item.sheet.render(true);
  }

  /* -------------------------------------------- */

  /**
   * Handle deleting an existing Owned Item for the Actor
   * @param {Event} event   The originating click event
   * @private
   */
  _onItemDelete(event) {
    event.preventDefault();
    const li = event.currentTarget.closest(".item");
    const item = this.actor.items.get(li.dataset.itemId);
    if ( item ) return item.delete();
  }

 /**
   * Handle collapsing a Feature row on the actor sheet
   * @param {Event} event   The originating click event
   * @private
   */
   
_onItemCollapse(event) {
    event.preventDefault();

    event.currentTarget.classList.toggle("active");

    const li = event.currentTarget.closest("li");
    const content = li.querySelector(".content");

    if (content.style.display === "none") {
      content.style.display = "block";
    } else {
      content.style.display = "none";
    }
  }

/**
   * Handle incrementing class level on the actor sheet
   * @param {Event} event   The originating click event
   * @private
   */
 
 _onIncrementClassLevel(event) {
  event.preventDefault();

  const div = event.currentTarget.closest(".character")
  const li = event.currentTarget.closest("li");

  const actorId = div.id.split("-")[1];
  const itemId = li.dataset.itemId;

  const actor = game.actors.get(actorId);
  const item = actor.items.get(itemId);

  let levels = item.data.data.levels;
  const update = {_id: item.data._id, data: {levels: (levels + 1) }};

  actor.updateEmbeddedDocuments("Item", [update]);
}
 
/**
   * Handle decrementing class level on the actor sheet
   * @param {Event} event   The originating click event
   * @private
   */
 
 _onDecrementClassLevel(event) {
  event.preventDefault();

  const div = event.currentTarget.closest(".character")
  const li = event.currentTarget.closest("li");

  const actorId = div.id.split("-")[1];
  const itemId = li.dataset.itemId;

  const actor = game.actors.get(actorId);
  const item = actor.items.get(itemId);

  let levels = item.data.data.levels;
  const update = {_id: item.data._id, data: {levels: (levels - 1) }};

  actor.updateEmbeddedDocuments("Item", [update]);
}

  /* -------------------------------------------- */

  /**
   * Handle rolling an Ability check, either a test or a saving throw
   * @param {Event} event   The originating click event
   * @private
   */
  _onRollAbilityTest(event) {
    event.preventDefault();
    let ability = event.currentTarget.parentElement.dataset.ability;
    return this.actor.rollAbility(ability, {event: event});
  }

  /* -------------------------------------------- */

  /**
   * Handle rolling a Skill check
   * @param {Event} event   The originating click event
   * @private
   */
  _onRollSkillCheck(event) {
    event.preventDefault();
    const skill = event.currentTarget.parentElement.dataset.skill;
    return this.actor.rollSkill(skill, {event: event});
  }

  /* -------------------------------------------- */

  /**
   * Handle toggling Ability score proficiency level
   * @param {Event} event     The originating click event
   * @private
   */
  _onToggleAbilityProficiency(event) {
    event.preventDefault();
    const field = event.currentTarget.previousElementSibling;
    return this.actor.update({[field.name]: 1 - parseInt(field.value)});
  }

  /* -------------------------------------------- */

  /**
   * Handle toggling of filters to display a different set of owned items
   * @param {Event} event     The click event which triggered the toggle
   * @private
   */
  _onToggleFilter(event) {
    event.preventDefault();
    const li = event.currentTarget;
    const set = this._filters[li.parentElement.dataset.filter];
    const filter = li.dataset.filter;
    if ( set.has(filter) ) set.delete(filter);
    else set.add(filter);
    return this.render();
  }

  /* -------------------------------------------- */

  /**
   * Handle spawning the TraitSelector application which allows a checkbox of multiple trait options
   * @param {Event} event   The click event which originated the selection
   * @private
   */
  _onTraitSelector(event) {
    event.preventDefault();
    const a = event.currentTarget;
    const label = a.parentElement.querySelector("label");
    const choices = CONFIG.SW5E[a.dataset.options];
    const options = { name: a.dataset.target, title: label.innerText, choices };
    return new TraitSelector(this.actor, options).render(true)
  }

  /* -------------------------------------------- */

  /** @override */
  _getHeaderButtons() {
    let buttons = super._getHeaderButtons();
    if (this.actor.isPolymorphed) {
      buttons.unshift({
        label: 'SW5E.PolymorphRestoreTransformation',
        class: "restore-transformation",
        icon: "fas fa-backward",
        onclick: () => this.actor.revertOriginalForm()
      });
    }
    return buttons;
  }
}
