using System;
using System.IO;
using NUnit.Framework;
using UnityEngine;

namespace FailTraceExample
{
    public class InventoryTests
    {
        [Test]
        public void SaveRoundTripPreservesItems()
        {
            var input = Environment.GetEnvironmentVariable("FAILTRACE_INPUT");
            var original = string.IsNullOrEmpty(input)
                ? new Inventory { items = new[] { 101, 202, 303 } }
                : JsonUtility.FromJson<Inventory>(File.ReadAllText(input));
            original.items = original.items ?? Array.Empty<int>();
            var restored = InventoryStorage.Load(InventoryStorage.Save(original));
            CollectionAssert.AreEqual(original.items, restored.items, "INVENTORY_ITEMS_LOST");
        }
    }
}
